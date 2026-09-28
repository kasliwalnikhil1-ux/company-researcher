# Daily standup pipeline

Goal: the meeting reads itself. One `standup_brief()` call, then you narrate — the humans only decide next steps and commit numbers. Target: the whole standup in under 15 minutes, with every decision written back before it ends.

## 0. Prepare (before people join)
- `standup_brief()` (or `standup_brief(date)` for a different day). Read `crm://rules` once per session.
- If `uncaptured_meetings` is non-empty, **that is item 1**: those meetings happened and nobody captured them, so the scoreboard is wrong and the no-show data is missing. For each, run the capture flow (see capture-pipeline.md) with the owner before moving on. Do not let the standup proceed on uncaptured meetings.

## 1. Yesterday's numbers (≤ 1 minute)
From `scoreboard`: read `day.totals` next to `trailing_7d.totals` (per-day average = 7d ÷ 7). Then per channel in `day.channels` — only channels with non-zero numbers. Format:

```
Yesterday (Wed 15 Sep) · dials 16 (7d avg 9) · connects 7 · LI accepts 4 · replies 0 · booked 0 · held 0 · no-shows 0 · proposals 0 · closes 0
  Cold call: 16 dials, 7 connects       LinkedIn: 4 accepts
```
Call out: a channel where no-shows ≥ held; zero replies on a channel with heavy outbound; a day with no dials.

## 2. Today's meetings (one line each)
From `meetings_today`, in time order:
`11:00 IST · StoryVerse Audio — Ananya Iyer (Head of Marketing) · meeting_booked · ₹4,50,000/mo · PocketFM/story via LinkedIn · owner Aarushi · last touch 3d ago · ⚠ 1 prior no-show`
Then for each, in one sentence: what the last capture said (pain points, next step) or, for a first meeting, the thread so far. If someone wants the full story: `whos_meeting_today()` has the complete activity history and last capture per meeting — quote the pain points verbatim.
For meetings with `prior_no_shows > 0`: suggest a reminder message now.

## 3. Deals needing attention
From `attention` — three short lists, owner first:
- **Stuck** (no next step / date): ask the owner "what is the next step and when?" and immediately `update_deal(deal_id, next_step, next_step_date)`. Do not leave the standup with stuck deals.
- **Stale** (no activity ≥ N days): ask "touch or kill?" — a touch means the owner logs it after the meeting (`log_activity`), kill means `update_deal(stage: "lost", reason)`.
- **Slipping** (next step overdue): ask for the new date or the outcome; `update_deal` accordingly (if the step happened, log it as an activity too).

## 4. Yesterday's commitments vs actual
From `yesterday_commitments`: one line per person, `dials 12/15, connects 4/4, booked 0/1 — missed 2/3`. State it, no commentary. If `commitment_vs_actual(from: <7 days ago>)` shows `repeat_misses`, name them once.

## 5. Today's commitments
Ask each person for numbers using the measured keys only: `dials, connects, linkedin_connects, linkedin_messages, emails, meetings_booked, proposals_sent, closes`. Collect in one message, then a single `log_commitments_bulk(rows)`. Confirm what was saved.

## 6. Digest (5 lines, paste-ready)
```
Standup 16 Sep · yesterday 16 dials / 7 connects / 0 booked (7d: 62 / 19 / 3)
Meetings today: StoryVerse 11:00, Bright Minds 15:30, Glow Theory 19:00 (proposal walkthrough)
Fixed: 2 stuck (next steps set), 1 stale killed (Riff Records), 2 slipping rescheduled
Misses yesterday: Nikhil booked 0/1
Commitments: Aarushi 20 dials / 5 connects / 1 booked · Nikhil 15 LI connects / 1 proposal
```

## Anti-patterns
- Narrating deals that are fine. Only meetings today + the three attention lists.
- Writing a next step you inferred; the owner says it, you write it.
- Reporting a number the tools did not return (no "roughly", no averages you did not compute from the data).
- Skipping uncaptured meetings because "we'll do it later".
