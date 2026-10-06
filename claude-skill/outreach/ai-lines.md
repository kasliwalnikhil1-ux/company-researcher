# Personalized lines (AI first lines: generate → check → approved lines only)

The app calls this **Personalized lines**. Lines that wait for a person are Line cards in **AI → Needs you**; the variables and all their lines are under **AI → Setup → Personalized lines**. It is separate from **AI replies** (answers to inbound messages; see ai-replies.md).

The platform's rule: **nothing AI-written sends unless it is approved.** `{{ai.<key>|fallback}}` resolves only to a line whose status is `approved`. Pending, unreviewed, skipped, blank and failed lines all send the **fallback**. Every approved line records who approved it. A variable has a mode:

- **Review** (the default): a person approves every line.
- **Off**: no new lines are written for the variable. Leads waiting for a line start with the fallback; lines already approved keep being used.
- **Auto** is not available for lines yet: the app shows it locked and `ai_variable_set_mode` refuses it.

You are never the approver. The mode is the manager's setting, not a shortcut for you.

## Steps

1. `ai_variables_list` → the variables a manager defined in AI → Setup → Personalized lines: `key`, `mode` (off | review), prompt, fallback, `needs_posts`, `max_chars` and how many lines sit in each state. Use one in copy as `{{ai.icebreaker|Saw your work at {{company}}.}}`.
2. `ai_variable_generate(variable_id, lead_ids | filters, sequence_id?)` ⚠ → `batch_id`, `to_generate`, `kept_existing`. It costs LLM usage and sends nothing. Leads without an enriched profile are queued for enrichment first (leftover profile views only), so their lines arrive later. `regenerate: true` rewrites lines that were already approved: their approval is lost, so ask. A variable that is Off writes nothing (`E_AI_VARIABLE_OFF`): say so, and switch it back to Review only if the user asks.
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

## Modes (Off · Review)

- Switching a variable Off or back to Review (`ai_variable_set_mode(variable_id, mode)` ⚠, manager; in the app: AI → Setup → Personalized lines) happens only when the user asks for it in those words. Never suggest Off to unblock waiting leads. Say what it means: Off = no new lines are written, leads waiting for a line start with the fallback, approved lines keep being used; Review = a person approves each line.
- Auto (lines approved by the platform's checks) is not available yet, so the two points below apply only once it is.
- When Auto has paused itself (`dashboard.attention` kind `ai_lines_auto_paused`), show the reason and the example lines. Resuming needs a manager and a short note saying what changed; ask the user for the note text.
- A spot check is quality control, not a gate: those lines are already approved. Offer them to the user as "worth a look", never as blocking.

## Fields variables

A variable writes either one line or **Fields**: one AI call per lead fills up to 8 named, typed fields (text, number, yes/no, choice). `ai_variables_list` shows `output: "fields"`, the `fields` (key, name, type, options) and the ready tokens in `use_as`. In step text use one field at a time, with the fallback inside the token: `{{ai.research.pain|growing outbound}}`. Put a yes/no field inside `{{#if ai.research.hiring_sales}}…{{else}}…{{/if}}`, because printing it gives true or false, and never write `{{ai.research}}` without a field for a Fields variable. To route leads, use a `condition` step on `ai.<key>.<field>` (for example `{"do": "condition", "field": "ai.research.icp_fit", "op": "eq", "value": "high", "true": […], "false": […]}`): a choice field takes `eq` / `neq` with one of its options, a yes/no field takes `eq` with `true` or `false`, a number field takes `gt` / `gte` / `lt` / `lte` / `eq`, a text field takes `contains` / `not_contains` / `eq`, and every field takes `exists` / `not_exists`. Only an approved value counts, in messages and in conditions: a lead with no approved value (skipped, blank, failed, or the variable is Off) reads as empty, so every rule is false except `not_exists`. When the sequence holds leads for review (`hold_for_ai_review`), a lead waits before such a condition until its value is approved or skipped, the same way it waits before a message. Review works on the whole value: in `ai_review_list` its `line` is a readable summary ("ICP fit: high · Pain: …") and `data` holds the fields. Show them as a small Field · Value table, and record an edit with `ai_review(value_ids: [id], action: "edit", data: {…})` carrying only the fields the user changed; like any edit, it approves the value.

## Waiting leads

With the sequence setting `hold_for_ai_review`, enrolled leads wait (`waiting_for: ai_review`) until their line is approved or skipped, then start by themselves. The waiting lines are the Line cards of AI → Needs you (`ai_needs_you_list` with `type: "line"`, or `ai_review_list`). A sequence can also set a maximum wait (`ai_hold_max_hours`, 36 on new sequences) after which the lead starts with the fallback. `enroll_commit` reports them under `waiting`; `why_not_sending` shows `W_WAITING_AI_REVIEW`; the dashboard shows `ai_lines_awaiting` and an `ai_review` attention item. Blank and failed lines never hold a lead: the fallback is used.

## Enrichment feeds the lines

- Leads **in a sequence** are enriched for free: the profile fetch the sequence already makes before its steps now stores about, roles, education, skills, languages and counts.
- `leads_enrich(lead_ids | filters, want_posts?, force?)` is for leads **not** in a sequence (⚠ above 50). Budget rule: only profile views left over after the day's sequence actions, at most 30% of a sender's allowance, inside working hours, none at warm-up level 0–1. A big batch takes days. Profiles enriched in the last 90 days are skipped unless `force`.
- Posts are a separate allowance. Ask for them (`want_posts`) only when something uses them: `{{enrich.recent_post}}`, an AI variable with `needs_posts`, AI routing, a posted-recently filter.
- `lead_get` shows `enrich_status` and the stored profile. `empty_sections` means LinkedIn returned that section empty last time: unknown, not absent.

## Bring your own key

A workspace can use its own Gemini / Anthropic / OpenAI key (AI → Setup → General). `E_AI_KEY_INVALID` means the provider rejected it: a manager re-enters it or switches back to the platform key. Until then leads get the fallback; nothing fails.
