# AI first lines and AI variables (generate → check → approved lines only)

The app calls this **AI Personalization** (the sidebar page and the Settings tab). It is separate from **AI Auto Replies** (answers to inbound messages; see ai-replies.md).

The platform's rule: **nothing AI-written sends unless it is approved.** `{{ai.<key>|fallback}}` resolves only to a line whose status is `approved`. Pending, unreviewed, skipped, blank and failed lines all send the **fallback**. Every approved line records who approved it:

- **Review** mode (the default): a person approves every line.
- **Auto** mode, which a manager turns on per variable in the app: lines that pass every automatic check are approved by the platform (`approval_source: auto`), and the rest wait for a person with the checks they failed.

You are never the approver. Auto is the manager's setting, not a shortcut for you.

## Steps

1. `ai_variables_list` → the variables a manager defined in Settings → AI Personalization: `key`, prompt, fallback, `needs_posts`, `max_chars`, how many lines sit in each state, and (once the platform has it) `approval_mode`. Use one in copy as `{{ai.icebreaker|Saw your work at {{company}}.}}`.
2. `ai_variable_generate(variable_id, lead_ids | filters, sequence_id?)` ⚠ → `batch_id`, `to_generate`, `kept_existing`. It costs LLM usage and sends nothing. Leads without an enriched profile are queued for enrichment first (leftover profile views only), so their lines arrive later. `regenerate: true` rewrites lines that were already approved: their approval is lost, so ask. For an Auto variable, say before generating that lines passing the checks will be approved without a person.
3. `ai_review_list(batch_id)` → per line: lead, company, title, the generated `line`, `facts` (the profile facts it relied on), the `fallback`, and, where present, `check_failures` and `approval_source`.
4. **Show the user a table**, with lines that need review first: Lead · Facts used · Line · Failed checks. Flag anything that looks off: a fact not in `facts`, flattery, a guess, a line over the channel limit. The writer may only use facts from the profile; a line that invents something should be skipped or edited. Show auto-approved lines only when the user asks, or as a spot check.
5. Record exactly what the user decided with `ai_review(value_ids, action)`:
   - `approve` the ids the user approved ("all of these" is fine **after they saw them**), including lines that failed a check if the user overrides it,
   - `edit` one id with the user's wording (`text`), which also approves it,
   - `regenerate` to try again (it returns to the table and is checked again),
   - `skip` to never use it (the fallback is sent),
   - where the platform offers them: `revoke` an auto-approved line that has not been sent (reason required), `flag` a sent line, `spot_ok` a spot-check line.
   More than one id returns a confirmation that quotes the lines: show it, then confirm.

Never call `approve` because a line looks fine to you, because it passed the checks, because the user said "handle it", or to unblock waiting leads. If the user has not read the lines, the answer is "here they are".

## Auto mode

- Switching a variable to Auto or back (`ai_variable_set_mode` ⚠ once the connector lists it, otherwise the manager does it in Settings → AI Personalization) happens only when the user asks for it in those words. Never suggest it to unblock waiting leads. Say what it means: lines that pass the checks are sent without anyone reading them; the first 20 still go to review.
- When Auto has paused itself (`dashboard.attention` kind `ai_lines_auto_paused`), show the reason and the example lines. Resuming needs a manager and a short note saying what changed; ask the user for the note text.
- A spot check is quality control, not a gate: those lines are already approved. Offer them to the user as "worth a look", never as blocking.

## Waiting leads

With the sequence setting `hold_for_ai_review`, enrolled leads wait (`waiting_for: ai_review`) until their line is approved (by a person, or by the checks in Auto) or skipped, then start by themselves. A sequence can also set a maximum wait (`ai_hold_max_hours`, 36 on new sequences) after which the lead starts with the fallback. `enroll_commit` reports them under `waiting`; `why_not_sending` shows `W_WAITING_AI_REVIEW`; the dashboard shows `ai_lines_awaiting` and an `ai_review` attention item. Blank and failed lines never hold a lead: the fallback is used.

## Enrichment feeds the lines

- Leads **in a sequence** are enriched for free: the profile fetch the sequence already makes before its steps now stores about, roles, education, skills, languages and counts.
- `leads_enrich(lead_ids | filters, want_posts?, force?)` is for leads **not** in a sequence (⚠ above 50). Budget rule: only profile views left over after the day's sequence actions, at most 30% of a sender's allowance, inside working hours, none at warm-up level 0–1. A big batch takes days. Profiles enriched in the last 90 days are skipped unless `force`.
- Posts are a separate allowance. Ask for them (`want_posts`) only when something uses them: `{{enrich.recent_post}}`, an AI variable with `needs_posts`, AI routing, a posted-recently filter.
- `lead_get` shows `enrich_status` and the stored profile. `empty_sections` means LinkedIn returned that section empty last time: unknown, not absent.

## Bring your own key

A workspace can use its own Gemini / Anthropic / OpenAI key (Settings → AI Personalization). `E_AI_KEY_INVALID` means the provider rejected it: a manager re-enters it or switches back to the platform key. Until then leads get the fallback; nothing fails.
