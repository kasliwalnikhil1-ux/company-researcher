# AI fields + Insert Variables: as built

Source PRD: `ai-fields-json-changes.md` (repo root). This file is the contract of what was built and every place it differs
from the PRD. Built 2026-10-01 on top of the AI hub (`docs/outreach/AI-HUB.md`, migration 063).

- **Part A, AI fields:** a Personalized-lines variable can write several typed fields from one AI call. Each field prints in
  a message as `{{ai.<variable>.<field>}}` and routes a lead in a Condition step as `ai.<variable>.<field>`.
- **Part B, Insert Variables:** the Variable button of a message box is a popup with five tabs, a search and a
  Variable Name | Example table. Every name it lists renders at send time.

## 0. Where it differs from the PRD

| # | PRD | Built | Why |
|---|---|---|---|
| 1 | Migrations `065_ai_fields.sql`, `066_insert_variables.sql` | `066_ai_fields.sql`, `067_insert_variables.sql` | 065 was taken by `065_webchat_video_languages.sql` |
| 2 | `outreach_ai_fields_valid / _clean / _summary` | `outreach_hub_fields_valid / _clean / _summary` | The grant loops of 037/042 revoke `authenticated` from every `outreach_ai_*` function outside their lists. The check constraint runs `…_valid` as the user who saves a variable, so it must keep its grant |
| 3 | `{{ai.research}}` of a Fields variable: builder error only | Builder error (`E_AI_FIELDS_BARE`) **and** the renderer prints nothing for it (the fallback is used) | A template saved through the API or the connector never sends raw JSON |
| 4 | Condition on `ai.<key>` of a Fields variable: not specified | Reads the summary text, so *has a value* / *is empty* work | Same meaning as for a one-line variable |
| 5 | Needs you / Activity "with no view change" | `outreach_ai_needs_you.meta` of a line also carries `output`, `fields`, `data` | The Line card draws the table and the typed editor from one query. Columns are unchanged |
| 6 | Guard trigger checks graph + draft | Also versions that leads still run on; archived sequences with no running leads hold nothing | A pinned version would otherwise lose its field |
| 7 | Constraint `output in ('text','fields') and (output = 'text' or valid(fields))` | Also: a one-line variable has `fields = []` | One shape per output |
| 8 | Built-ins "generated the same as any AI variable" | A built-in the sequence uses is created and waited for at enrolment **also when the sequence does not hold leads for review** (`outreach_enroll_leads`, `outreach_release_waiting` patched) | Otherwise a built-in would only ever be written for sequences with "Hold leads until AI-written lines are approved", and everywhere else the raw field would be sent. The wait is seconds and never needs a person |
| 9 | Off for a built-in | The stored value stops rendering and rules read nothing; `outreach_ensure_ai_values` creates a value of **any** switched-off variable as `skipped` | "Off → the raw field is used". It also closes a 063 gap: a lead enrolled while a variable is Off no longer gets a line written or waits for one |
| 10 | Built-ins in `outreach_hub_setup` | Left out of its `variables` list, out of Activity and out of the All lines list | Those are about lines a person reviews |
| 11 | `{{ sn_id }}` from `linkedin.sales_navigator_id` | Same key, stored by `profileFacts` when the profile answer carries it | Not confirmed on a Sales Navigator fetch yet: empty until then |
| 12 | Location: 1 part → city | 1 part that is a country name → country. 2 parts whose second is not a country, with a known profile country → city, region | "India" alone is a country; "Austin, Texas" + US reads better as city, region |
| 13 | Timezone "when the country has one" | Also countries where nearly everyone lives in one zone (ES, PT, NZ, CL, EC, FR, GB, NL, DK). US, CA, AU, BR, RU, MX, ID, KZ, MN, CD stay empty | A wrong morning / evening is worse than none |
| 14 | Company not found | A row with only `linkedin_id` + `fetched_at` is stored | Stops a lookup (and its budget) repeating for every lead of that company for 90 days |
| 15 | Popup lists the PRD's names only | Plus `{{ enrich.years_in_role }}`, `{{ enrich.months_in_role }}`, `{{ enrich.top_skill }}` under "More profile data", and a box to type any custom field key | The old picker offered them; no option is lost |
| 16 | Popup AI row `{{ ai.<key> }}` | `{{ ai.<key> | <saved fallback> }}` when the variable has a fallback | The old picker inserted the fallback; without it an unapproved lead gets nothing |
| 17 | Renderer "nothing else changes" | Paths read own keys of objects only (`{{constructor}}`, `{{title.length}}` print nothing) | They printed JavaScript internals before |
| 18 | `t in FILTERS` | Own-key check | `{{name|constructor}}` would have been read as a filter |
| 19 | A fallback with a pipe (`{{x|a | b}}`) | Kept exactly as written when no filter is present | Old templates render byte for byte |
| 20 | Unknown AI variable | `W_AI_FIELD_UNKNOWN` also when the variable does not exist or writes one line | A rule on it is false for everyone |
| 21 | Sender label | `outreach_update_sender` accepts `label` (≤ 80 chars, empty clears) | The settings page saves through that RPC |
| 22 | Built-ins "usually seconds" | `outreach_ai_claim_pending` takes a built-in at once; a line still waits (up to a day) while the lead is in the enrichment queue | A built-in tidies a field the lead already has. Without this a lead could wait a day for its first name |
| 23 | One small call per built-in value | No call when the first name is already one clean capitalised word (and not a title such as "Dr") | Saves a call per lead; the result is the same |
| 24 | Company fetch through `unipile.linkedin.company` | The same endpoint with one 15-second attempt and no retries; skipped while the sender's profile reads are throttled | It runs inside a profile fetch and must not hold it up |
| 25 | Connector `ai_review(edit, data)` | A partial `data` is merged onto the stored value before it is saved; unknown field keys are refused | The SQL replaces the whole object, so a one-field edit would have emptied the others |
| 26 | Company mapping "from the first real response" | Written from the documented shape, read defensively (`companyFacts` in `_shared/outreach/enrich.ts`) | No captured response yet. **Check the first real rows** in `outreach_companies` (field names, and whether `hq_country` is a name or a 2-letter code) |

## 1. Data (066)

- `outreach_ai_variables.output` (`text` | `fields`, fixed after creation) and `fields` jsonb:
  `[{key, name, type: text|number|yes_no|choice, description?, max_chars? (text, 20–1000, default 200), options? (choice, 2–12, ≤ 40 chars)}]`, 1 to 8 entries.
- `outreach_ai_values.data` jsonb: `{<field key>: string | number | boolean | null}`. `text` holds the summary
  (`ICP fit: high · Pain: … · Hiring sales: Yes · Team size: 40`), so the hub's views, "is there anything to approve" and
  blank / failed work unchanged. Every field empty → `blank`.
- Functions: `outreach_hub_fields_valid(jsonb)`, `outreach_hub_fields_clean(fields, data, strict)` (AI output: a bad value
  becomes null; a person's edit: `E_PAYLOAD_INVALID` naming the field), `outreach_hub_fields_summary(fields, data)`,
  `outreach_ai_value_result_fields(id, data, facts, model, error)` (service),
  `outreach_hub_line_fields_edit(value, data)` (member; approves, like editing a line).
- Patched in place (anchors asserted): `outreach_render_context` (`ai.<key>` is the object for a Fields variable),
  `outreach_eval_rule` (`ai.<key>.<field>` reads the approved value), `outreach_ai_review` (regenerate clears `data`;
  `edit` refuses a Fields value), `outreach_ai_generate_request`, `outreach_hub_setup` (`output` per variable), the view
  `outreach_ai_needs_you`. `outreach_sequence_ai_keys` replaced: also finds a variable from a Condition rule and from `{{#if}}`.
- Guard trigger `outreach_hub_fields_guard`: `E_PAYLOAD_INVALID` on an output change; `E_AI_FIELD_IN_USE: "Pain" is used in: …`
  when a field in use is removed or changes type.
- Rules: only **approved** values count, in messages and in Conditions. A lead with no approved value (skipped, blank,
  failed, Off) is empty: every rule is false except *is empty*. A lead waits for review before a Condition that reads an AI
  field the same way it waits before a message (the sequence setting "Hold leads until AI-written lines are approved").

## 2. Data (067)

- `outreach_ai_variables.builtin`, `outreach_senders.label`, table `outreach_companies` (one row per LinkedIn company per
  workspace, members read, service writes; `outreach_company_due`, `outreach_company_save`).
- `outreach_template_normalize(text)`: the SQL mirror of `normalizeTemplate()`. Used by `outreach_spintax_info` (length check).
- Render context: `lead.tags`, `lead.work_email_domain`, `sender.email` (a mailbox's own address; a LinkedIn sender's linked
  mailbox, else the owner's email), `sender.label`, `sender.timezone`, `account` (current role's company id, else
  `lead.company_id`, else by domain; `{}` when none), `now` (`day, month, weekday, year, time_of_day` in the lead's
  `location_timezone`, else the sender's, else UTC).
- `outreach_lead_enrich_ctx` gains `sn_id, last_enrich_at, twitter_url, facebook_url, phone, location_city/region/country,
  location_timezone, current_started_on, current_duration, experience_summary, education_field, education_summary,
  last_3_posts`. The location parts exist without a stored profile.
- Built-ins: `contact_first_name`, `company_conversation`, `position_conversational`, seeded into every workspace
  (`outreach_seed_builtin_variables`; a trigger seeds new workspaces; a workspace's own variable with one of those keys
  wins). A trigger blocks creating, editing and deleting them; On / Off is `mode` (`review` = on). The prompts live in
  `supabase/functions/_shared/outreach/ai.ts`; a result must pass the check in code (every word comes from the source
  field) and is then stored approved by nobody (`outreach_ai_value_result_builtin`), else blank → the alias falls back to
  the raw field.

## 3. Templates

`lib/outreach/render.ts` and `supabase/functions/_shared/outreach/render.ts` are identical below the header
(`bash scripts/outreach-render-test.sh`, 119 shared cases in `lib/outreach/render.cases.json`).

- Names: `VARIABLE_ALIASES` maps every Insert Variables name to a path, or to a list where the first non-empty value wins.
- Filters after a pipe: `lowercase`, `uppercase`, `capitalize_each_word`, `plural`; chained left to right; applied to the
  value or to the fallback. A fallback that is exactly a filter word acts as a filter.
- Tags: `{% if x %}…{% else %}…{% endif %}`, `{% if x == "y" %}`, and `{{ "Hey|Hello" | spintax }}` are rewritten to the
  native syntax before spintax runs, on the template only (a value is never re-scanned).
- `{{#if x == "y"}}` compares trimmed, case-insensitive. `{{#if}}` is false for `false` and for an empty list.

## 4. App

- **Setup → Personalized lines:** Output One line · Fields (locked after creation), the field table, click-to-copy tokens,
  Try on a lead (Field · Value table). Built-ins: three read-only rows with On / Off.
- **Needs you / All lines / lead page:** a Fields value is a Field · Value table; Edit opens typed inputs and saves
  through `outreach_hub_line_fields_edit`.
- **Sequence builder:** `Insert Variables` popup (`components/outreach/sequences/InsertVariablesModal.tsx`, catalogue in
  `lib/outreach/variables.ts`); Condition step group **AI fields** (`aiConditionFields` in `lib/outreach/nodes.ts`);
  checks in `lib/outreach/graph.ts`: `E_AI_FIELDS_BARE` (blocks publish), `W_AI_FIELD_UNKNOWN`, `W_AI_FIELD_YESNO_PRINTED`,
  `W_TEMPLATE_UNKNOWN_FILTER`.
- **Senders → Settings:** "Label in messages".
- **Connector:** `ai_variables_list` (output, fields, built-ins), `ai_review_list` (`data`), `ai_review` (`edit` with `data`).

## 5. Tests

| What | Command |
|---|---|
| Renderer, both copies, identical | `bash scripts/outreach-render-test.sh` |
| Builder rules, catalogue, field model | `npx tsx lib/outreach/aiFields.test.ts` |
| Built-in check in code (7 tests) | `SUPABASE_URL=http://localhost SUPABASE_SERVICE_ROLE_KEY=x SUPABASE_ANON_KEY=x deno test -A --node-modules-dir=none supabase/functions/_shared/outreach/ai_test.ts` |
| SQL 066 (20 assertions) | `bash scripts/outreach-smoke.sh migrations/outreach/tests/smoke_16_ai_fields.sql` |
| SQL 067 (20 assertions) | `bash scripts/outreach-smoke.sh migrations/outreach/tests/smoke_17_insert_variables.sql` |

## 6. Rollout order

1. `066_ai_fields.sql`, then `067_insert_variables.sql` (both idempotent, both additive).
2. Edge functions: `outreach-ai-variables`, every function that imports `_shared/outreach/render.ts`, `ai.ts` or `enrich.ts`
   (the executor, the workers, `outreach-mcp`). Simplest: the full `scripts/outreach-deploy-functions.sh`.
3. The web app (git push).

Order matters only one way: the app and the functions read columns the migrations add, so the SQL goes first. Old
templates render the same before and after. There is no backfill: company rows fill in as leads are enriched; built-in
values are written when a lead enters a sequence that uses them.
