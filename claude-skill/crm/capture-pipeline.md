# Meeting capture pipeline

Goal: a complete capture in under a minute, right after the meeting, in the prospect's own words. `capture_meeting` is the only way a meeting becomes `held` or `no_show`, and it refuses partial rows — so collect everything first, then write once.

## 1. Identify the meeting (one tool call)
- User names a company/contact/time → `meetings_list(status: "scheduled", from: <7 days ago>, to: <today>)` and pick the match; or `search(q)` → company → `meetings_list(company)`.
- Nothing named → show the uncaptured past meetings from `meetings_list` (`uncaptured_past` > 0) and ask which one.
- Confirm in one line: "StoryVerse · Ananya Iyer · today 11:00 IST · meeting `5ad3…` — held or no-show?"

## 2. Ask for exactly the fields the outcome needs — in ONE message

**Held**
1. Pain points, in their words — "what did they say hurts?" (quote, do not paraphrase; one per line)
2. Commercials — price quoted, volume (videos/month), currency; or "not discussed"
3. Objections (optional)
4. Next step + date — or "it's dead" + why

**No-show**
1. Why (what happened / what they said, or "no reply")
2. Follow-up action
3. Follow-up date

Accept shorthand ("₹40k/video, 8/mo", "call Fri") and normalise it yourself: currency codes (INR/USD/GBP/AED/EUR), ISO dates in the team timezone, arrays for pain points and objections.

## 3. Write once
```
capture_meeting(meeting_id, outcome: "held",
  pain_points: ["every video goes through three compliance rounds and agencies bill each round", "doctors skip anything over 90 seconds"],
  commercials_discussed: {price: 40000, currency: "INR", volume: 8, notes: "per video"},
  objections: ["compliance turnaround"],
  next_step: "Send compliance-friendly storyboard sample", next_step_date: "2026-09-18")
```
or
```
capture_meeting(meeting_id, outcome: "no_show",
  no_show_reason: "Did not join; no reply to reminder 10 min before",
  follow_up_action: "Call to rebook; send 2 samples first", follow_up_date: "2026-09-17")
```
- `commercials_discussed: {none: true}` when explicitly not discussed — never leave it out.
- Dead deal: `is_dead: true, dead_reason: "…"` instead of next step (the deal moves to lost with that reason).
- `tags` optional: pass normalised tags (e.g. `["compliance", "video length"]`) when the verbatim pain points are long; otherwise each pain point becomes a tag.

## 4. Handle the response
- `E_CAPTURE_INCOMPLETE` → the message lists the missing fields. Ask only for those, then call again with the **full** payload. Never fall back to `update_meeting` or `update_deal` to "mark it held".
- `E_ALREADY_CAPTURED` → `update_capture(meeting_id, …)` for corrections.
- `E_MEETING_CANCELLED` → `update_meeting(meeting_id, status: "scheduled", scheduled_at)` then capture.
- Success → confirm: meeting status, deal stage (`meeting_held`, or `lost`), next step + date, tags created, `is_repeat_no_show` (⚠ flag it — second no-show for a contact usually means a dead lead or a wrong contact).

## 5. Follow-through (same conversation)
- Value or volume changed in the meeting → `update_deal(deal_id, value_monthly, currency, videos_per_month)`.
- A proposal was promised → that is the next step; when sent, `update_deal(stage: "proposal_sent")`.
- A follow-up call was booked → `schedule_meeting(deal_id, scheduled_at, timezone)`.
- New stakeholder mentioned → `upsert_contact(company, name, role)`.

## Quality bar for pain points
Good: "our current UGC creators are flaky — half the videos come late". Bad: "reliability issues". The tag counts across deals (`top_pain_points`) are only useful if the verbatims are real; if the user gives you a paraphrase, ask "what were their actual words?" once, then accept what they have.
