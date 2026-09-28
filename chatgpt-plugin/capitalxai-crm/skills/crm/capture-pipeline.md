# Meeting capture pipeline

Goal: the user types a few words, the capture is saved. `capture_meeting` is the only way a meeting becomes `held` or `no_show`, and it refuses partial rows — so fill every required field from what was said plus the defaults below, then write once.

**The user gave a recording** (file, path or link)? Stop here and follow [recording-pipeline.md](recording-pipeline.md) instead — it transcribes the call and fills these same fields from what the prospect actually said.

## 1. Identify the meeting (no questions)
- User names a company/contact/email -> `search(q)` or `meetings_list(status: "scheduled", from: <7 days ago>, to: <today>)` and pick the match.
- Not in the CRM -> create it silently: `upsert_company` (name from the email domain, website = domain) -> `upsert_contact` -> `create_deal` (value + currency when a price was given) -> `schedule_meeting(deal_id, scheduled_at: today)`.
- Nothing named at all -> show the uncaptured past meetings (`uncaptured_past` > 0) and ask which one.

## 2. Fill the fields from what the user said - do not ask
Anything said about the conversation (pricing, a quote, what they need) means **held**. "Didn't join / no-show" means **no_show**.

**Held**
1. Pain points - the user's words as given, one per item. No rewording, no asking for exact quotes.
2. Commercials - `{price, volume, currency, notes}`; currency is **INR unless stated**; keep the phrasing in `notes` ("5K for 2 videos"). Nothing about price -> `{none: true}`.
3. Objections - only if mentioned. Never ask.
4. Next step - as given, else a short inferred one ("Follow up on 5K quote for 2 videos"). Date - as given, else **today**. "It's dead" -> `is_dead` + reason.

**No-show**
1. Why - as given, else "No-show".
2. Follow-up action - as given, else "Rebook the meeting". Date - as given, else today.

Source channel, role, meeting time, owner: skip when not mentioned (owner = whoever is connected). Normalise shorthand yourself: currency codes, ISO dates in the team timezone, arrays.

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
- `E_CAPTURE_INCOMPLETE` → the message lists the missing fields. Fill them from the defaults; ask only if one truly cannot be inferred, then call again with the **full** payload. Never fall back to `update_meeting` or `update_deal` to "mark it held".
- `E_ALREADY_CAPTURED` → `update_capture(meeting_id, …)` for corrections.
- `E_MEETING_CANCELLED` → `update_meeting(meeting_id, status: "scheduled", scheduled_at)` then capture.
- Success → confirm: meeting status, deal stage in plain words ("Meeting held", or "Lost"), next step + date, tags created, `is_repeat_no_show` (⚠ flag it — second no-show for a contact usually means a dead lead or a wrong contact).

## 5. Follow-through (same conversation)
- Value or volume changed in the meeting → `update_deal(deal_id, value_monthly, currency, videos_per_month)`.
- A proposal was promised → that is the next step; when sent, `update_deal(stage: "proposal_sent")`.
- A follow-up call was booked → `schedule_meeting(deal_id, scheduled_at, timezone)`.
- New stakeholder mentioned → `upsert_contact(company, name, role)`.

## Pain points
Store what the user typed. Short is fine ("need realism"). Pass a one-word `tags` entry (e.g. `["realism"]`) so `top_pain_points` groups well. Never push back for verbatims.
