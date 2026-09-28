# AI first lines and AI variables (generate → review → approved lines only)

The platform's rule: **nothing AI-written sends without a person approving it.** `{{ai.<key>|fallback}}` resolves only to a line whose status is `approved` (the approver is recorded). Pending, generated-but-unreviewed, skipped, blank and failed lines all send the **fallback**. There is no auto-send, and you are not the approver.

## Steps

1. `ai_variables_list` → the variables a manager defined in Settings → AI: `key`, prompt, fallback, `needs_posts`, `max_chars`, and how many lines sit in each state. Use one in copy as `{{ai.icebreaker|Saw your work at {{company}}.}}`.
2. `ai_variable_generate(variable_id, lead_ids | filters, sequence_id?)` ⚠ → `batch_id`, `to_generate`, `kept_existing`. It costs LLM usage and sends nothing. Leads without an enriched profile are queued for enrichment first (leftover profile views only), so their lines arrive later. `regenerate: true` rewrites lines that were already approved: their approval is lost, so ask.
3. `ai_review_list(batch_id)` → per line: lead, company, title, the generated `line`, `facts` (the profile facts it relied on) and the `fallback`.
4. **Show the user a table**: Lead · Facts used · Line. Flag anything that looks off: a fact not in `facts`, flattery, a guess, a line over the channel limit. The writer may only use facts from the profile; a line that invents something should be skipped or edited.
5. Record exactly what the user decided with `ai_review(value_ids, action)`:
   - `approve` the ids the user approved ("all of these" is fine **after they saw them**),
   - `edit` one id with the user's wording (`text`), which also approves it,
   - `regenerate` to try again (it returns to the table),
   - `skip` to never use it (the fallback is sent).
   More than one id returns a confirmation that quotes the lines: show it, then confirm.

Never call `approve` because a line looks fine to you, because the user said "handle it", or to unblock waiting leads. If the user has not read the lines, the answer is "here they are".

## Waiting leads

With the sequence setting `hold_for_ai_review`, enrolled leads wait (`waiting_for: ai_review`) until their line is approved or skipped, then start by themselves. `enroll_commit` reports them under `waiting`; `why_not_sending` shows `W_WAITING_AI_REVIEW`; the dashboard shows `ai_lines_awaiting` and an `ai_review` attention item. Blank and failed lines never hold a lead: the fallback is used.

## Enrichment feeds the lines

- Leads **in a sequence** are enriched for free: the profile fetch the sequence already makes before its steps now stores about, roles, education, skills, languages and counts.
- `leads_enrich(lead_ids | filters, want_posts?, force?)` is for leads **not** in a sequence (⚠ above 50). Budget rule: only profile views left over after the day's sequence actions, at most 30% of a sender's allowance, inside working hours, none at warm-up level 0–1. A big batch takes days. Profiles enriched in the last 90 days are skipped unless `force`.
- Posts are a separate allowance. Ask for them (`want_posts`) only when something uses them: `{{enrich.recent_post}}`, an AI variable with `needs_posts`, AI routing, a posted-recently filter.
- `lead_get` shows `enrich_status` and the stored profile. `empty_sections` means LinkedIn returned that section empty last time: unknown, not absent.

## Bring your own key

A workspace can use its own Gemini / Anthropic / OpenAI key (Settings → AI). `E_AI_KEY_INVALID` means the provider rejected it: a manager re-enters it or switches back to the platform key. Until then leads get the fallback; nothing fails.
