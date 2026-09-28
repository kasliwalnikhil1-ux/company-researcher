# Copy iteration (sequence edits)

Goal: improve a sequence from its own numbers, and save it without losing a step, breaking threading, or leaving a campaign paused.

## 1. Numbers
`get_campaign_analytics(campaign_id, by_step: true)` → overall sent / reply / positive / bounce, and per step: sent, replied, reply rate. Typical reads:
- Step 1 carries most replies; a step with many sends and ~0 replies is dead weight or badly timed.
- Bounce rate over the threshold → this is a list/mailbox problem, not copy. Stop and run the burn check instead.
- Low volume (< ~100 sends on a step) → say the number is not meaningful yet.

If `steps_note` says per-step totals are unavailable, work from the overall numbers and say so — do not invent step rates.

## 2. Current copy
`get_campaign_sequences(campaign_id)` (HTML — this is what you send back). Note for each step: `step_id`, `delay_in_days`, subject, variants, and `threads_as_reply: true` (a step 2+ with a deliberately **empty** subject).

## 3. Propose
Per step: current → proposed, with the reason tied to a number. Leave working steps alone. Rules:
- Keep Smartlead variables (`{{first_name}}`, `{{company_name}}`, custom fields) exactly as written, and only use ones that already appear or that the lead list is known to have.
- **A blank subject on step 2+ stays blank** — it threads the follow-up under step 1. Filling it in turns a bump into a new cold email.
- Bodies are HTML; keep the existing structure (`<p>`, `<br>`), no images or tracking tricks, no link in step 1 unless there already was one.
- A/B: add a variant (`variants: [{variant_label:"A",…},{variant_label:"B",…}]`) rather than overwriting the control when the volume allows a test.
- Spacing changes are `delay_in_days` on the step.

## 4. Save — after the human approves the copy
`update_campaign_sequences(campaign_id, sequences: [EVERY step])`:
- every existing step goes back, changed or not, with its `id` (= `step_id`); new steps have no id; `seq_number` runs 1..N without gaps
- deleting a step on purpose: leave it out **and** list it in `remove_seq_numbers` — otherwise `E_SEQUENCE_INCOMPLETE`
- first call → `effect_summary` with the per-step diff (+ "will be PAUSED, saved and RESUMED" when ACTIVE) and a `confirmation_token`; show it verbatim
- on yes → same arguments + token

Outcomes:
- `changed: true` with `steps_now` → confirm what was saved.
- `changed: false` → identical to the current sequence.
- `E_LEFT_PAUSED` → the campaign is still PAUSED. Tell the human immediately, including whether the sequence was saved (`detail.sequence_saved`); offer `resume_campaign` (gated) or the Smartlead UI.
- A save error on an ACTIVE campaign → the tool already resumed it with the OLD sequence; report the Smartlead message and fix the payload.

Leads already past a step are not re-sent it; leads still before it get the new copy.

## 5. Re-check
Say when the change will have enough volume to judge (sends per day × days) and offer to re-run step 1 then.
