# Change PRD: AI fields (Clay-style JSON personalization) + Insert Variables popup

**Applies to:** the app as built through `063_ai_hub.sql` (Personalized lines with Off/Review per variable, Needs you, Activity).
**Goal:**
- **Part A (§0–§13):** one AI call per lead returns several typed fields (JSON). Each field can be printed in any message **and** used in a normal Condition step to route the lead.
- **Part B (§14–§22):** an **Insert Variables** popup in the message box, with tabs, search and a Variable Name | Example table.

**Migrations:**
- `065_ai_fields.sql` (Part A). 064 is taken by `064_ai_hub_cron.sql`.
- `066_insert_variables.sql` (Part B).

Both are additive: every existing variable and template keeps working exactly as today.

---

## 0. Summary (Part A)

| # | Change |
|---|---|
| 1 | A Personalized line variable gets **Output: One line · Fields**. "Fields" = up to 8 named, typed fields filled by one AI call |
| 2 | Field types: **Text · Number · Yes/No · Choice** (one of a list) |
| 3 | Messages use `{{ai.<variable>.<field>}}`, with the usual `|fallback`, and `{{#if ai.<variable>.<field>}}` |
| 4 | Condition step gets an **AI fields** group, typed: Choice shows its options, Yes/No shows yes/no, Number shows the number operators |
| 5 | Review is unchanged: one card per lead per variable. The card shows the fields as a small table and can edit them one by one |
| 6 | Leads wait for review before a **Condition** that uses an AI field, the same way they wait before a message |

**Not in this change:** nested JSON, list fields, AI fields as columns in the Leads table (see §10), feeding AI fields into the AI routing step.

---

## 1. Example (what the user does)

**Variable** `research` · Output: Fields · prompt: *"Judge this lead against our ICP: B2B SaaS, 20–500 people, sells outbound."*

| Field | Key | Type | Description |
|---|---|---|---|
| ICP fit | `icp_fit` | Choice: high, medium, low | How well the company matches the ICP |
| Pain | `pain` | Text, 120 chars | Their most likely outbound pain, in their words if possible |
| Hiring sales | `hiring_sales` | Yes/No | Profile or posts show they are hiring SDRs/AEs |
| Team size | `team_size` | Number | Employees, if the profile states it |

**AI returns, per lead:**
```json
{ "icp_fit": "high", "pain": "scaling outbound without adding SDRs", "hiring_sales": true, "team_size": 40 }
```

**Message:**
```
Hi {{first_name}}, saw you're working on {{ai.research.pain|growing outbound}}.
{{#if ai.research.hiring_sales}}Before the next SDR hire, worth a look:{{else}}Quick idea:{{/if}} …
```

**Condition step:** `AI fields → Research · ICP fit` · `is` · `high` → true branch to the founder-led path, false branch to the nurture path.

---

## 2. Setup UI

Where: AI → Setup → Personalized lines → variable editor (`/outreach/ai/setup/lines/:variableId`). Until the hub UI ships, the same form in `AiVariablesCard`.

```
Name        Research
Key         research
Output      ( One line )  ( • Fields )

Prompt      Judge this lead against our ICP: …

Fields                                                     4 / 8
┌────────────────┬──────────┬──────────────────────┬──────────────┐
│ ICP fit        │ Choice ▾ │ high, medium, low    │ How well …   │ 🗑
│ Pain           │ Text ▾   │ 120 characters       │ Their most … │ 🗑
│ Hiring sales   │ Yes/No ▾ │                      │ Profile or … │ 🗑
│ Team size      │ Number ▾ │                      │ Employees …  │ 🗑
└────────────────┴──────────┴──────────────────────┴──────────────┘
+ Add field

Uses recent posts  [ ]          Try on a lead: [ Search lead… ]  [Try]

Use in a message:  {{ai.research.icp_fit}}  {{ai.research.pain}}  …   (click to copy)
```

Rules:
- **Output** is picked when the variable is created and is locked after that. To switch, create a new variable.
- **Field key** comes from the name (same slug rule as variable keys, max 30 chars). It is locked once saved. To rename a key, delete the field and add it again.
- **Text** fields have their own max characters (20–1000, default 200). The variable-level *Max characters* and *Fallback* inputs are hidden for Fields. In messages the fallback goes in the token: `{{ai.research.pain|growing outbound}}`.
- **Choice** takes 2–12 options, each up to 40 chars.
- **Removing a field, or changing its type,** is blocked while a sequence uses it: *"Pain is used in: Q4 SaaS founders, Agency follow-up. Remove it from those sequences first."* Adding a field is always allowed. Existing leads get the new field when their value is regenerated.
- **Try on a lead** shows the result as a Field · Value table plus the facts it relied on, like today's single-line preview.

---

## 3. Messages (templates)

| Token | Renders |
|---|---|
| `{{ai.research.pain}}` | The text, or nothing if empty |
| `{{ai.research.pain\|growing outbound}}` | The text, or the fallback |
| `{{ai.research.team_size}}` | `40` |
| `{{ai.research.icp_fit}}` | `high` |
| `{{#if ai.research.hiring_sales}}…{{else}}…{{/if}}` | Yes → first part; No or empty → `else` |
| `{{ai.research}}` (no field) | Not allowed for a Fields variable: builder error, see §6 |

**Variable picker** (`TemplateField.tsx`, the `ai` group): a Fields variable is listed as a heading with one row per field (`Research → Pain`). Text, Number and Choice rows insert `{{ai.research.pain}}`. A Yes/No row inserts `{{#if ai.research.hiring_sales}}{{/if}}` with the cursor inside, because printing a Yes/No field gives `true`/`false`.

**Renderer change** (`lib/outreach/render.ts` and `supabase/functions/_shared/outreach/render.ts`, kept identical): today `{{#if}}` treats only `undefined/null/''` as empty, so `false` would count as true. Add one helper used **only** by `applyConditionals`:

```ts
function isFalsy(v: unknown): boolean {
  return isEmpty(v) || v === false || (Array.isArray(v) && v.length === 0);
}
```

Nothing else in the renderer changes. Dot paths already walk into `ctx.ai.research`. Add cases to `scripts/outreach-render-test.sh` (§11).

---

## 4. Routing (Condition step)

**Editor** (`ConditionEditor.tsx` + `lib/outreach/nodes.ts`): a new group **AI fields**, built from the workspace's Fields variables. `CONDITION_FIELDS` stays static. Add:

```ts
// nodes.ts
export function aiConditionFields(vars: AiVariable[]): ConditionFieldMeta[]
// one entry per field: value 'ai.<key>.<field>', label '<Variable> · <Field>', group 'AI fields'
//   text   → kind 'text',    defaultOp 'contains', ops eq/neq/contains/not_contains/exists/not_exists
//   number → kind 'number',  defaultOp 'gte',      ops eq/gt/lt/gte/lte/exists/not_exists
//   yes_no → kind 'boolean', defaultOp 'eq'
//   choice → kind 'select',  defaultOp 'eq', ops eq/neq/exists/not_exists, options = field options
```

`conditionFieldMeta(field)` and `conditionOpsFor(field)` also look up these entries. The builder context (`useBuilder`) exposes the AI variables, which `useAiVariables` already loads for `TemplateField`. Extend the `group` union in `ConditionFieldMeta` with `'AI fields'`. A rule saved for a field that no longer exists is still shown, using the existing `!meta` path.

**Evaluation** (`outreach_eval_rule`): add one branch before `else actual := null; end if;`. Patch it in place like 063 does, with an asserted anchor:

```sql
  elsif f like 'ai.%' then
    select case when av.output = 'fields' then x.data ->> split_part(f, '.', 3) else x.text end
      into actual
      from outreach_ai_values x join outreach_ai_variables av on av.id = x.variable_id
     where x.lead_id = p_lead.id and av.workspace_id = p_lead.workspace_id
       and av.key = split_part(f, '.', 2) and x.status = 'approved';
```

- `->>` gives `'true'/'false'` for Yes/No, which is exactly how the existing boolean rules compare. Numbers compare with the existing `gt/lt/...` numeric casts. Choice and text compare case-insensitively like every other text rule.
- Only **approved** values count, the same rule as messages. A lead with no approved value (skipped, blank, failed, Off) is empty: every rule is false except *is empty*. Users who want to route those leads separately add an *is empty* rule.
- A plain one-line variable also works as `ai.icebreaker` with *has a value* / *is empty*. The editor lists one-line variables in the same group under *"<Variable> · has a line"*.

**Why this rather than the AI routing step:** AI routing calls the AI per lead at the step. A Condition on AI fields costs nothing at the step, gives the same answer every time, and reuses the one call that also wrote the message fields. AI routing stays for judgement calls nobody wants to turn into fields.

---

## 5. Leads wait for review before an AI-field condition

Today `outreach_sequence_ai_keys(graph)` only finds `{{ai.<key>`, so a Condition step using `ai.research.icp_fit` would not create or wait for the value. Replace it (it's an `immutable` SQL function, so a plain `create or replace`):

```sql
create or replace function outreach_sequence_ai_keys(p_graph jsonb) returns text[]
language sql immutable as $$
  select coalesce(array_agg(distinct k), '{}') from (
    select m[1] k from regexp_matches(coalesce(p_graph::text,''), '\{\{\s*#?(?:if\s+)?ai\.([a-z][a-z0-9_]*)', 'g') m
    union
    select m[1] from regexp_matches(coalesce(p_graph::text,''), '"field"\s*:\s*"ai\.([a-z][a-z0-9_]*)', 'g') m
  ) t
$$;
```

Mirror it in `sequenceAiKeys()` in `lib/outreach/graph.ts` (same two patterns). Its three callers (011, 012, 026) need no change: they create the values and hold the lead with `wait_reason = 'ai_review'` exactly as they do for message variables.

---

## 6. Builder checks (`lib/outreach/graph.ts` warnings)

| Code | When | Message |
|---|---|---|
| `E_AI_FIELDS_BARE` (blocks publish) | A template uses `{{ai.<key>}}` and `<key>` is a Fields variable | "Pick a field: {{ai.research.pain}}, {{ai.research.icp_fit}}, …" |
| `W_AI_FIELD_UNKNOWN` | A template or condition uses `ai.<key>.<field>` and that field does not exist | "Research has no field 'pains'" |
| `W_AI_FIELD_YESNO_PRINTED` | A Yes/No field is printed as `{{ai.x.y}}` outside `{{#if}}` | "This prints true/false. Use it in {{#if …}} instead" |

---

## 7. Review (Needs you) and Activity

**Needs you, line card:** for a Fields value the body is a two-column table (Field · Value), not one line. Approve, Skip and Regenerate work exactly as today, on the whole value. **Edit** opens typed inputs: text with a character counter, a number input, a yes/no toggle, a choice dropdown. Saving approves, like editing a line does today.

**Activity:** unchanged. It shows `text`, which for a Fields value is the readable summary (§8.2), e.g. `ICP fit: high · Pain: scaling outbound without adding SDRs · Hiring sales: Yes · Team size: 40`.

**Lead page:** under the existing AI lines, a Fields value shows as the same small table (approved values only).

---

## 8. Data

### 8.1 Schema

```sql
alter table outreach_ai_variables add column if not exists output text not null default 'text';
alter table outreach_ai_variables add column if not exists fields jsonb not null default '[]';
-- fields: [{ "key":"icp_fit", "name":"ICP fit", "type":"choice", "description":"…", "options":["high","medium","low"] },
--          { "key":"pain", "name":"Pain", "type":"text", "max_chars":120, "description":"…" }, …]
do $$ begin
  alter table outreach_ai_variables add constraint outreach_ai_variables_output_chk
    check (output in ('text','fields') and (output = 'text' or outreach_ai_fields_valid(fields)));
exception when duplicate_object then null; end $$;

alter table outreach_ai_values add column if not exists data jsonb;   -- Fields variables only; text keeps the summary
```

**Design choice:** a Fields value stores the typed object in `data` **and** a readable summary in `text`. Everything 063 built that reads `text` keeps working unchanged: the `outreach_ai_outputs` and `outreach_ai_needs_you` views, the "is there anything to approve" check in `outreach_ai_review`, the blank/failed rule and `generated_at`. So does the render context's non-empty filter.

### 8.2 New SQL functions

```sql
-- shape check, used by the constraint
create or replace function outreach_ai_fields_valid(p jsonb) returns boolean language sql immutable as $$
  select case when jsonb_typeof(p) <> 'array' or jsonb_array_length(p) not between 1 and 8 then false else
    (select count(distinct f->>'key') from jsonb_array_elements(p) f) = jsonb_array_length(p)
    and not exists (select 1 from jsonb_array_elements(p) f where not (
          coalesce(f->>'key','') ~ '^[a-z][a-z0-9_]{1,29}$'
      and length(btrim(coalesce(f->>'name',''))) between 1 and 40
      and length(coalesce(f->>'description','')) <= 300
      and coalesce(f->>'type','') in ('text','number','yes_no','choice')
      and (f->>'type' <> 'text' or coalesce((f->>'max_chars')::int, 200) between 20 and 1000)
      and (f->>'type' <> 'choice' or (jsonb_typeof(f->'options') = 'array' and jsonb_array_length(f->'options') between 2 and 12)))) end
$$;

-- coerce AI or human input to the declared fields. strict = raise on a bad value (edits); else the value becomes null (AI output)
create or replace function outreach_ai_fields_clean(p_fields jsonb, p_data jsonb, p_strict boolean default false) returns jsonb
language plpgsql immutable as $$
declare f jsonb; k text; t text; s text; o text; lim int; ok boolean; out jsonb := '{}';
begin
  for f in select * from jsonb_array_elements(coalesce(p_fields, '[]')) loop
    k := f->>'key'; t := f->>'type'; ok := true;
    s := btrim(regexp_replace(coalesce(p_data->>k, ''), '\s+', ' ', 'g'));
    if jsonb_typeof(p_data->k) is null or jsonb_typeof(p_data->k) = 'null' or s = '' or lower(s) in ('null','none','n/a') then
      out := out || jsonb_build_object(k, null); continue;
    end if;
    if t = 'text' then
      lim := coalesce((f->>'max_chars')::int, 200) * 2;                 -- same slack as editing a line today
      if s ~ '\{\{|\}\}' then ok := false;                               -- a leftover placeholder is not a value
      elsif length(s) > lim then if p_strict then ok := false; else s := left(s, lim); end if; end if;
      if ok then out := out || jsonb_build_object(k, s); end if;
    elsif t = 'number' then
      s := replace(s, ',', '');
      if s ~ '^-?[0-9]+(\.[0-9]+)?$' then out := out || jsonb_build_object(k, s::numeric); else ok := false; end if;
    elsif t = 'yes_no' then
      if lower(s) in ('true','yes','y') then out := out || jsonb_build_object(k, true);
      elsif lower(s) in ('false','no','n') then out := out || jsonb_build_object(k, false);
      else ok := false; end if;
    elsif t = 'choice' then
      o := null;
      select x into o from jsonb_array_elements_text(f->'options') x where lower(x) = lower(s) limit 1;
      if o is null then ok := false; else out := out || jsonb_build_object(k, o); end if;
    end if;
    if not ok then
      if p_strict then raise exception 'E_PAYLOAD_INVALID: "%" is not a valid %', f->>'name', replace(t, '_', '/'); end if;
      out := out || jsonb_build_object(k, null);
    end if;
  end loop;
  return out;
end $$;

-- the readable line kept in outreach_ai_values.text; null when every field is empty (→ status blank)
create or replace function outreach_ai_fields_summary(p_fields jsonb, p_data jsonb) returns text language sql immutable as $$
  select nullif(string_agg((f->>'name') || ': ' ||
           case jsonb_typeof(p_data->(f->>'key')) when 'boolean' then case when (p_data->>(f->>'key'))::boolean then 'Yes' else 'No' end
                else p_data->>(f->>'key') end, ' · ' order by o), '')
    from jsonb_array_elements(coalesce(p_fields, '[]')) with ordinality t(f, o)
   where coalesce(jsonb_typeof(p_data->(f->>'key')), 'null') <> 'null'
$$;

-- service: store an AI result for a Fields variable, then reuse the existing result path (status, batch, release)
create or replace function outreach_ai_value_result_fields(p_id uuid, p_data jsonb, p_facts jsonb, p_model text, p_error text default null) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare flds jsonb; clean jsonb;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  select av.fields into flds from outreach_ai_values x join outreach_ai_variables av on av.id = x.variable_id
   where x.id = p_id and x.status = 'pending' and av.output = 'fields';
  if not found then return; end if;
  clean := case when p_error is null then outreach_ai_fields_clean(flds, p_data, false) end;
  update outreach_ai_values set data = clean where id = p_id and status = 'pending';
  perform outreach_ai_value_result(p_id, outreach_ai_fields_summary(flds, clean), p_facts, p_model, p_error);
end $$;
revoke execute on function outreach_ai_value_result_fields(uuid,jsonb,jsonb,text,text) from public, anon, authenticated;

-- user: edit the fields of one value (= approve with these values). outreach_hub_* name on purpose (grant-loop gotcha)
create or replace function outreach_hub_line_fields_edit(p_value uuid, p_data jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare x outreach_ai_values%rowtype; av outreach_ai_variables%rowtype; clean jsonb; summary text;
begin
  select * into x from outreach_ai_values where id = p_value for update;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  select * into av from outreach_ai_variables where id = x.variable_id;
  perform outreach_require(x.workspace_id, 'member');
  if not outreach_client_visible(x.workspace_id, (select client_id from outreach_leads where id = x.lead_id)) then raise exception 'E_FORBIDDEN: client not visible'; end if;
  if av.output <> 'fields' then raise exception 'E_PAYLOAD_INVALID: this variable writes one line; edit it with ai_review(edit)'; end if;
  if av.mode = 'off' then raise exception 'E_AI_VARIABLE_OFF: "%" is switched off', av.name; end if;
  clean := outreach_ai_fields_clean(av.fields, p_data, true);
  summary := outreach_ai_fields_summary(av.fields, clean);
  if summary is null then raise exception 'E_PAYLOAD_INVALID: fill at least one field, or skip this lead'; end if;
  update outreach_ai_values set data = clean, text = summary, edited = true, status = 'approved',
         approved_by = auth.uid(), approved_at = now(), updated_at = now() where id = p_value;
  perform outreach_release_waiting(x.lead_id, 'ai_review');
  return jsonb_build_object('updated', 1, 'data', clean);
end $$;
revoke execute on function outreach_hub_line_fields_edit(uuid,jsonb) from public, anon;
grant execute on function outreach_hub_line_fields_edit(uuid,jsonb) to authenticated;
```

### 8.3 Patched in place (same `__patch` helper pattern as 063, anchors asserted, helper dropped at the end)

Copy the **live** definitions (063 already patched `outreach_ai_value_result` and `outreach_ai_review`). Do not copy them from 014.

| Function | Anchor → replacement |
|---|---|
| `outreach_render_context` | `jsonb_object_agg(v.key, x.text)` → `jsonb_object_agg(v.key, case when v.output = 'fields' then x.data else to_jsonb(x.text) end)`. The `x.status = 'approved'` and non-empty `text` filters stay |
| `outreach_eval_rule` | Insert the §4 branch before `else actual := null; end if;` |
| `outreach_ai_review` (regenerate) | `attempts = 0, text = null` → `attempts = 0, text = null, data = null` |
| `outreach_ai_generate_request` (upsert) | `attempts = 0, text = null` → `attempts = 0, text = null, data = null` |
| `outreach_sequence_ai_keys` | Full `create or replace` (§5) |

`outreach_ai_review(edit)` is left as it is: it rejects a Fields value with `E_PAYLOAD_INVALID: edit the fields with outreach_hub_line_fields_edit`. Add `var.output` to the loop's select (next to `var.mode as var_mode`), then add that one check inside the `edit` branch.

### 8.4 Guard trigger on `outreach_ai_variables`

```sql
create or replace function outreach_ai_fields_guard() returns trigger language plpgsql as $$
declare f jsonb; pat text; used text;
begin
  if tg_op = 'UPDATE' and new.output is distinct from old.output then
    raise exception 'E_PAYLOAD_INVALID: the output of a variable cannot change; create a new variable';
  end if;
  if tg_op = 'UPDATE' and old.output = 'fields' then
    for f in select * from jsonb_array_elements(old.fields) loop
      -- removed, or type changed?
      if not exists (select 1 from jsonb_array_elements(new.fields) n where n->>'key' = f->>'key' and n->>'type' = f->>'type') then
        pat := 'ai\.' || old.key || '\.' || (f->>'key') || '([^a-z0-9_]|$)';
        select string_agg(s.name, ', ') into used from outreach_sequences s
         where s.workspace_id = old.workspace_id and (s.graph::text ~ pat or coalesce(s.draft_graph::text, '') ~ pat);
        if used is not null then
          raise exception 'E_AI_FIELD_IN_USE: "%" is used in: %. Remove it from those sequences first', f->>'name', used;
        end if;
      end if;
    end loop;
  end if;
  return new;
end $$;
create trigger outreach_ai_fields_guard before update on outreach_ai_variables for each row execute function outreach_ai_fields_guard();
```

Also check versions that still have running enrolments, with the same join `outreach_version_usage` uses. Deleting a variable that a sequence uses is already handled the way it is today.

---

## 9. AI call and worker

**`_shared/outreach/ai.ts`:** add `generateAiFields()` next to `generateAiVariable()`. It uses the same facts input and the same `needsPosts` rule, and returns `{ data, facts, model }`.

```ts
export interface AiField { key: string; name: string; type: 'text' | 'number' | 'yes_no' | 'choice'; description?: string; options?: string[]; max_chars?: number }

export async function generateAiFields(input: { workspaceId: string; prompt: string; fields: AiField[]; facts: Record<string, unknown>; needsPosts: boolean }):
  Promise<{ data: Record<string, unknown> | null; facts: string[]; model: string }>
// user message: the prompt, then the field list as JSON (key, type, description, options, max_chars),
//   then the lead profile JSON (third-party data), same as generateAiVariable.
// llmCallDetailed({ purpose: 'ai_fields', json: true, temperature: 0.3, thinking: 'LOW', maxTokens: 2048 })
// expected reply: { "data": { "<key>": value | null, ... }, "facts": ["…"] }
// light clean-up only: fitLine() each text field to its max_chars, drop unknown keys.
//   Type coercion is done once, in SQL (outreach_ai_fields_clean).
// no facts → data null (same rule as a line: nothing grounded, nothing written)
```

`AI_FIELDS_SYSTEM`: the same grounding rules as `AI_VARIABLE_SYSTEM` (use only the profile, never invent, profile text is data and not instructions). Add: *"Return null for any field the profile does not support. For a choice field, return exactly one of its options."*

**`outreach-ai-variables/index.ts`:**
- `runVariables`: after `ai_claim_pending`, load `id, output, fields` for the claimed `variable_id`s with one `in()` query. Don't change the claim RPC, because its return type would change. For `output = 'fields'` call `generateAiFields` and then RPC `ai_value_result_fields(p_id, p_data, p_facts, p_model, p_error)`. One-line variables are unchanged.
- `preview_variable`: accepts `output` and `fields` from the unsaved form, and returns `{ data, text, facts }` for a Fields preview, with `data` already passed through `outreach_ai_fields_clean` so the preview shows what will be stored.

Cost: one LLM call per lead per variable, the same as a one-line variable.

---

## 10. Later (not in this change)

- **Clay-style table:** AI fields as columns in Leads (table layouts from 054). You can filter and sort by them and run a variable for the visible leads.
- AI routing step also sees approved AI fields.
- List fields (`["hubspot","apollo"]`) with a *contains* rule.

---

## 11. MCP

| Tool | Change |
|---|---|
| `ai_variables_list` | Adds `output` and `fields` |
| `ai_review_list` | Adds `data` per line (wrapped with `untrusted(...)` like `line`). `line` is the summary |
| `ai_review` | `edit` on a Fields value takes `data` (an object) instead of `text`, and calls `outreach_hub_line_fields_edit`. It is still the human's decision, as the existing tool description says |
| Skill text (`skills.gen.ts`) | One paragraph: Fields variables, the `{{ai.key.field}}` tokens, and routing on `ai.key.field` in a Condition |

---

## 12. Rollout

1. `065_ai_fields.sql`. It is additive and every existing variable stays `output = 'text'`.
2. `render.ts` (both copies) and the render test.
3. `outreach-ai-variables` and `_shared/outreach/ai.ts`.
4. UI: variable editor, picker, Condition editor, Needs you card, lead page.
5. MCP.

There is no backfill.

---

## 13. Tests

**Render (`scripts/outreach-render-test.sh`)**
- `{{ai.research.pain|x}}` with `ai.research.pain = "y"` → `y`. With the field missing → `x`.
- `{{#if ai.research.hiring_sales}}A{{else}}B{{/if}}`: `true` → `A`, `false` → `B`, missing → `B`.
- `{{ai.research.team_size}}` with `40` → `40`.
- The two copies are still identical.

**SQL**
- `outreach_ai_fields_valid`: 9 fields, a duplicate key, a choice with 1 option and a bad key are all rejected. A valid set passes.
- `outreach_ai_fields_clean`, non-strict:
  - `"Yes"` → `true`, `"1,200"` → `1200`, choice `"High"` → `"high"`, choice `"huge"` → `null`, text containing `{{x}}` → `null`.
  - Strict raises on each of those bad values.
- `outreach_ai_value_result_fields`: all fields null → status `blank` and the lead is released. Some fields set → `generated`, and `text` = the summary.
- `outreach_render_context`: approved Fields value → `ai.research` is an object. Generated (not approved) → absent.
- `outreach_eval_rule`:
  - `ai.research.icp_fit eq high` is true. `ai.research.hiring_sales eq true` is true.
  - `ai.research.team_size gte 20` is true.
  - With the value skipped: `eq` is false and `not_exists` is true.
- `outreach_sequence_ai_keys`: finds `research` from a condition rule alone, from `{{#if ai.research.x}}` and from `{{ai.research.x}}`.
- Enrolment into a sequence whose only use is a Condition on `ai.research.icp_fit` creates the value and waits with `ai_review`. Approving it releases the lead and it takes the right branch.
- Guard trigger:
  - Removing a field used in a sequence draft raises `E_AI_FIELD_IN_USE`.
  - Adding a field passes. Changing `output` raises.
- `outreach_hub_line_fields_edit`:
  - A bad choice raises.
  - A valid edit approves, sets `edited` and releases the lead.
  - A one-line variable raises.
- Needs you and Activity views show Fields values, using the summary text, with no view change.

**UI**
- The Condition editor shows AI fields with the right inputs: options for Choice, yes/no for Yes/No, the number input for Number.
- The picker inserts `{{#if …}}` for a Yes/No field.
- Publish is blocked on `{{ai.research}}` (`E_AI_FIELDS_BARE`).

---
---

# Part B: Insert Variables popup

## 14. Summary (Part B)

| # | Change |
|---|---|
| 1 | The **Variable** button in the message box becomes **Insert Variables** and opens a popup |
| 2 | Five tabs: **AI Variables · Contact · Account · Sender Profile · Advanced** |
| 3 | A search bar at the top, then a two-column table: **Variable Name \| Example** |
| 4 | Clicking a row inserts the variable at the cursor, exactly as shown |
| 5 | Every listed variable renders when the message is sent. Each one comes from data the app has, or from the small additions in §19 |

**Unchanged:** the Spintax, If and Preview buttons. Templates already written with the old syntax (`{{first_name|there}}`, `{{enrich.about}}`, `{{#if company}}…{{/if}}`, `{Hi|Hello}`) still work, and nothing is rewritten.

**Where:** every `TemplateField` (`components/outreach/sequences/TemplateField.tsx`), which covers every step's message, subject, InMail, email body, invite note and comment. The inbox composer is not part of this change.

---

## 15. Popup

> The layout follows the screenshot you referenced. Where the screenshot differs from this spec, the screenshot wins.

```
┌────────────────────────────────────────────────────────────────┐
│  Insert Variables                                           ✕  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ 🔍 Search variables                                       │  │
│  └──────────────────────────────────────────────────────────┘  │
│  AI Variables   Contact   Account   Sender Profile   Advanced  │
│  ──────────────────────────────────────────────────────────    │
│  Variable Name                        Example                  │
│  {{ first_name }}                     Priya                    │
│  {{ last_name }}                      Sharma                   │
│  {{ position }}                       Head of Growth           │
│  {{ headline }}                       Growth @ Acme · ex-Swiggy│
│  …                                                             │
└────────────────────────────────────────────────────────────────┘
```

| Item | Behaviour |
|---|---|
| Size | A centred modal, about 720 px wide and at most 70% of the screen height. The table scrolls and the header, search and tabs stay fixed |
| Open | Click **Insert Variables**. Focus goes to the search box. The tab last used in the session is selected (AI Variables the first time) |
| Search | Matches the variable name, case-insensitive, across **all** tabs. While searching, each tab shows its match count, e.g. `Contact (3)`. If the open tab has no matches, the popup switches to the first tab that does. No match anywhere shows *"No variables match"* |
| Variable Name | The token exactly as it will be inserted, in monospace |
| Example | The value for the lead in **Preview** (the same lead and sender the Preview panel uses, through `useRenderContext`). The example is the variable rendered by the real renderer, so it matches what will be sent. With no preview lead, the catalogue's sample appears in grey. An empty value shows `—`. Long values are cut to one line, with the full value on hover |
| Click a row | The token is inserted at the cursor, replacing any selected text. The popup closes and the cursor lands after the token |
| `{% if … %}` rows | Selected text is wrapped: `{% if first_name %}<selection>{% else %}{% endif %}`. The cursor lands inside the `if` |
| Keyboard | ↑/↓ moves through rows, Enter inserts, Esc closes, Ctrl/⌘+→/← switches tabs |
| Channel | Rows marked *email only* (§16) are hidden on LinkedIn, Instagram and WhatsApp steps, just as `emailOnly` works today |
| Plain fields | In URL and JSON fields (`plain`), the Advanced rows for `{% if %}` and spintax are hidden |
| Footer | One line of help: *"Add a fallback after a pipe: `{{ first_name \| there }}`"* |

---

## 16. Tabs and variables

The **Source** column says where each value comes from. ✓ = the data exists today. **New** = added in §19.

### 16.1 AI Variables

| Variable Name | Source | |
|---|---|---|
| `{{ ai_contact_first_name }}` | Built-in AI variable (§18). Falls back to `first_name` | New |
| `{{ ai_company_conversation }}` | Built-in AI variable (§18). Falls back to the current company | New |
| `{{ ai_position_conversational }}` | Built-in AI variable (§18). Falls back to the current title | New |
| `{{ ai.<key> }}` (one row per workspace variable) | The workspace's Personalized lines, approved text only | ✓ |
| `{{ ai.<key>.<field> }}` (one row per field) | Fields variables (Part A) | Part A |

Below the three built-ins, the workspace's own variables are listed under a small heading *"Your variables"*. If there are none: *"Create one under AI → Setup → Personalized lines."*

### 16.2 Contact

| Variable Name | Source | |
|---|---|---|
| `{{ full_name }}` | `lead.full_name` | ✓ |
| `{{ first_name }}` | `lead.first_name` (or the first word of the full name) | ✓ |
| `{{ last_name }}` | `lead.last_name` | ✓ |
| `{{ position }}` | `lead.title` | ✓ |
| `{{ headline }}` | `lead.headline` | ✓ |
| `{{ about }}` | `enrich.about` (first 600 chars) | ✓ |
| `{{ work_email }}` | `lead.email_work` | ✓ |
| `{{ personal_email }}` | `lead.email_personal` | ✓ |
| `{{ mobile_phone }}` | `lead.phone`, else the first phone on the LinkedIn profile | ✓ |
| `{{ work_phone }}` | `custom.work_phone` (map a CSV column to it on import) | ✓ |
| `{{ contact_uuid }}` | `lead.id` | ✓ |
| `{{ linkedin_nickname }}` | `lead.public_identifier` | ✓ |
| `{{ ln_id }}` | `lead.provider_id` | ✓ |
| `{{ sn_id }}` | Sales Navigator id from the stored profile | New |
| `{{ last_enrich_at }}` | Profile `enriched_at`, e.g. `Oct 1, 2026` | New |
| `{{ twitter_url }}` | Profile socials (X/Twitter). LinkedIn shows these to 1st-degree connections only | New |
| `{{ facebook_url }}` | Profile socials (Facebook), same rule | New |
| `{{ location_city }}` | Parsed from `lead.location` | New |
| `{{ location_country }}` | Parsed from `lead.location`, else the profile's country | New |
| `{{ location_address_string }}` | `lead.location` as stored | ✓ |
| `{{ location_region }}` | Parsed from `lead.location` | New |
| `{{ location_timezone }}` | From the country when it has one timezone, else empty | New |
| `{{ primary_language }}` | `enrich.language` | ✓ |
| `{{ connections_number }}` | `enrich.connections_count` | ✓ |
| `{{ followers_number }}` | `enrich.follower_count` | ✓ |
| `{{ skills }}` | `enrich.skills` (top three) | ✓ |
| `{{ tags }}` | The lead's tag names, comma-separated | New |
| `{{ current_company }}` | `enrich.current_company`, else `lead.company` | ✓ |
| `{{ work_email_domain }}` | The domain part of `lead.email_work` | New |
| `{{ current_position }}` | `enrich.current_title`, else `lead.title` | ✓ |
| `{{ current_company_start_date }}` | Profile `current_started_on`, e.g. `Mar 2022` | New |
| `{{ current_company_duration }}` | e.g. `2 yrs 3 mos` | New |
| `{{ previous_company }}` | `enrich.previous_company` | ✓ |
| `{{ previous_position }}` | `enrich.previous_title` | ✓ |
| `{{ experience_summary }}` | The last 3 roles: `Head of Growth at Acme (2022–present); …` | New |
| `{{ education_school }}` | `enrich.school` | ✓ |
| `{{ education_degree }}` | `enrich.degree` | ✓ |
| `{{ education_field }}` | First education entry, `field` | New |
| `{{ education_summary }}` | Up to 2 entries: `MBA, Marketing — IIM Bangalore; …` | New |
| `{{ latest_post }}` | `enrich.recent_post` (a post from the last 60 days, first 280 chars) | ✓ |
| `{{ latest_post_date }}` | `enrich.recent_post_date` | ✓ |
| `{{ last_3_posts }}` | Up to 3 stored posts, newest first, 280 chars each, separated by a blank line | New |
| `{{ custom.<key> }}` (one row per custom field key) | Custom fields, under a small heading *"Custom fields"* at the bottom of the tab, so no existing option is lost | ✓ |

### 16.3 Account

All Account values come from the lead's **current company**. The company is fetched once from LinkedIn and kept for 90 days (§19.3). Without a stored company, only `company_name`, `company_domain` and `company_ln_id` have values, taken from the lead.

| Variable Name | Source | |
|---|---|---|
| `{{ company_name }}` | Company name, else `lead.company` | New / ✓ |
| `{{ company_domain }}` | From the company website, else `lead.company_domain` | New / ✓ |
| `{{ company_website }}` | Company website | New |
| `{{ company_uuid }}` | Our company row id | New |
| `{{ company_linkedin }}` | `https://www.linkedin.com/company/<slug>` | New |
| `{{ company_ln_id }}` | LinkedIn company id, else `lead.company_id` | New / ✓ |
| `{{ company_phone }}` | Company phone | New |
| `{{ company_industry }}` | Industry | New |
| `{{ company_size }}` | Employee range, e.g. `51-200` | New |
| `{{ company_year_established }}` | Year founded | New |
| `{{ company_tagline }}` | Tagline | New |
| `{{ company_about }}` | Description (first 600 chars) | New |
| `{{ company_specialties }}` | Specialties, comma-separated | New |
| `{{ company_hashtags }}` | Hashtags, comma-separated | New |
| `{{ company_followers }}` | Followers | New |
| `{{ company_employees_on_linkedin }}` | Employee count on LinkedIn | New |
| `{{ company_deal_size }}` | `custom.company_deal_size` (set on import or through the API) | ✓ |
| `{{ company_location_city }}` | HQ city | New |
| `{{ company_location_country }}` | HQ country | New |
| `{{ company_location_address_string }}` | HQ address as one line | New |
| `{{ company_location_region }}` | HQ region or state | New |

### 16.4 Sender Profile

| Variable Name | Source | |
|---|---|---|
| `{{ sender_first_name }}` | `sender.first_name` | ✓ |
| `{{ sender_last_name }}` | `sender.last_name` | ✓ |
| `{{ sender_full_name }}` | `sender.full_name` | ✓ |
| `{{ sender_email }}` | For a mailbox sender, its address. For a LinkedIn sender, its linked mailbox, else the owner's email | New |
| `{{ sender_label }}` | The sender's label (new optional field in sender settings), else the display name | New |
| `{{ sender_booking_link }}` | `sender.booking_link`, kept from today's picker | ✓ |
| `{{ sender_signature }}` *(email only)* | `sender.signature`, kept from today's picker | ✓ |

### 16.5 Advanced

The examples assume today's date and the lead's timezone, else the sender's timezone (§19.2).

| Variable Name | Example | |
|---|---|---|
| `{{ now_day }}` | `14` (day of the month) | New |
| `{{ now_month }}` | `October` | New |
| `{{ now_time_of_day }}` | `morning` / `afternoon` / `evening` | New |
| `{{ now_weekday }}` | `Thursday` | New |
| `{{ now_year }}` | `2026` | New |
| `{% if first_name %}{% else %}{% endif %}` | *Text shown only when first_name has a value* | New syntax |
| `{% if first_name == "John" %}{% else %}{% endif %}` | *Text shown only when first_name is John* | New syntax |
| `{{ "Hey\|Hello\|Bonjour" \| spintax }}` | `Hey` / `Hello` / `Bonjour` (one per lead) | New syntax |
| `{{ position \| lowercase }}` | `head of growth` | New |
| `{{ position \| uppercase }}` | `HEAD OF GROWTH` | New |
| `{{ position \| capitalize_each_word }}` | `Head Of Growth` | New |
| `{{ position \| plural }}` | `Heads of Growth` | New |
| `{{ position \| capitalize_each_word \| plural }}` | `Heads Of Growth` | New |
| `{{ unsubscribe_link }}` *(email only)* | Kept from today's picker | ✓ |

**Single source:** a new `lib/outreach/variables.ts` holds the catalogue `{ tab, token, sample, emailOnly?, plainHidden? }` that the popup reads. Workspace AI variables, Fields and custom keys are added at runtime, the way `TemplateField` does today. `TEMPLATE_VARIABLE_GROUPS` stays for anything else that imports it.

---

## 17. Renderer: the syntax these variables need

Edit **both** `lib/outreach/render.ts` and `supabase/functions/_shared/outreach/render.ts` (they must stay identical, and `outreach-render-test.sh` checks that). Templates are still rendered at send time (`execute.ts`), so every change below takes effect at send time.

### 17.1 Names → existing paths

`VAR_RE` already accepts spaces (`{{ first_name }}`). Add an alias map. A list means the first non-empty value wins.

```ts
export const VARIABLE_ALIASES: Record<string, string | string[]> = {
  // AI (built-ins fall back to the raw field when there is no approved value)
  ai_contact_first_name: ['ai.contact_first_name', 'first_name'],
  ai_company_conversation: ['ai.company_conversation', 'enrich.current_company', 'company'],
  ai_position_conversational: ['ai.position_conversational', 'enrich.current_title', 'title'],
  // Contact
  position: 'title', about: 'enrich.about', work_email: 'email_work', personal_email: 'email_personal',
  mobile_phone: ['phone', 'enrich.phone'], work_phone: 'custom.work_phone', contact_uuid: 'id',
  linkedin_nickname: 'public_identifier', ln_id: 'provider_id', sn_id: 'enrich.sn_id',
  last_enrich_at: 'enrich.last_enrich_at', twitter_url: 'enrich.twitter_url', facebook_url: 'enrich.facebook_url',
  location_city: 'enrich.location_city', location_country: 'enrich.location_country', location_address_string: 'location',
  location_region: 'enrich.location_region', location_timezone: 'enrich.location_timezone',
  primary_language: 'enrich.language', connections_number: 'enrich.connections_count', followers_number: 'enrich.follower_count',
  skills: 'enrich.skills', current_company: ['enrich.current_company', 'company'],
  current_position: ['enrich.current_title', 'title'], current_company_start_date: 'enrich.current_started_on',
  current_company_duration: 'enrich.current_duration', previous_company: 'enrich.previous_company',
  previous_position: 'enrich.previous_title', experience_summary: 'enrich.experience_summary',
  education_school: 'enrich.school', education_degree: 'enrich.degree', education_field: 'enrich.education_field',
  education_summary: 'enrich.education_summary', latest_post: 'enrich.recent_post',
  latest_post_date: 'enrich.recent_post_date', last_3_posts: 'enrich.last_3_posts',
  // (tags and work_email_domain are keys on the lead object itself, §19.2: no alias needed)
  // Account
  company_name: ['account.name', 'company'], company_domain: ['account.domain', 'company_domain'],
  company_website: 'account.website', company_uuid: 'account.id', company_linkedin: 'account.linkedin_url',
  company_ln_id: ['account.linkedin_id', 'company_id'], company_phone: 'account.phone',
  company_industry: 'account.industry', company_size: 'account.size', company_year_established: 'account.founded_year',
  company_tagline: 'account.tagline', company_about: 'account.about', company_specialties: 'account.specialties',
  company_hashtags: 'account.hashtags', company_followers: 'account.followers',
  company_employees_on_linkedin: 'account.employees_on_linkedin', company_deal_size: 'custom.company_deal_size',
  company_location_city: 'account.hq.city', company_location_country: 'account.hq.country',
  company_location_address_string: 'account.hq.address', company_location_region: 'account.hq.region',
  // Sender
  sender_first_name: 'sender.first_name', sender_last_name: 'sender.last_name', sender_full_name: 'sender.full_name',
  sender_email: 'sender.email', sender_label: ['sender.label', 'sender.full_name'],
  sender_booking_link: 'sender.booking_link', sender_signature: 'sender.signature',
  // Advanced
  now_day: 'now.day', now_month: 'now.month', now_time_of_day: 'now.time_of_day', now_weekday: 'now.weekday', now_year: 'now.year',
};
```

- Rename today's `resolve` to `resolvePath`, and add two prefixes: `account` → `ctx.account` and `now` → `ctx.now`. The prefix is `account`, not `company`, because bare `{{company}}` already means `lead.company` in existing templates.
- The new `resolve(path)`: when `VARIABLE_ALIASES[path]` exists, return the first non-empty `resolvePath(p)` from its list. Otherwise use `resolvePath(path)`. Aliases are never resolved twice, so `company_domain → company_domain` cannot loop.
- `RenderContext` gets `account?` and `now?`.

### 17.2 Filters

After the name, each `|` segment that **exactly** matches a filter name is a filter. The remaining segment, if any, is the fallback, as today. Filters apply left to right to whichever text is used, the value or the fallback.

```ts
const FILTERS: Record<string, (s: string) => string> = {
  lowercase: (s) => s.toLowerCase(),
  uppercase: (s) => s.toUpperCase(),
  capitalize_each_word: (s) => s.replace(/(^|[\s\-/(&])(\p{L})/gu, (_m, p, c) => p + c.toUpperCase()),
  plural: pluralize,
};
function pluralWord(w: string): string {
  if (!w || /s$/i.test(w)) return w;                                     // Sales, Ops, Partners: leave alone
  if (/^[A-Z0-9]{2,5}$/.test(w)) return w + 's';                          // CEO → CEOs, VP → VPs
  const up = w.length > 1 && w === w.toUpperCase();
  if (/(x|z|ch|sh)$/i.test(w)) return w + (up ? 'ES' : 'es');
  if (/[^aeiou]y$/i.test(w)) return w.slice(0, -1) + (up ? 'IES' : 'ies');
  return w + (up ? 'S' : 's');
}
function pluralize(s: string): string {                                   // "Head of Growth" → "Heads of Growth"
  const m = /^(.*?)(\S+)(\s+(?:of|at|for|in)\s.*)$/i.exec(s);
  return m ? m[1] + pluralWord(m[2]) + m[3] : s.replace(/(\S+)(\s*)$/, (_x, w, sp) => pluralWord(w) + sp);
}
function splitPipes(rest?: string): { filters: string[]; fallback: string } {
  const filters: string[] = [], other: string[] = [];
  for (const seg of (rest ?? '').split('|')) { const t = seg.trim(); if (t in FILTERS) filters.push(t); else if (t) other.push(t); }
  return { filters, fallback: other.join('|') };
}
// applyVariables:
//   const { filters, fallback } = splitPipes(rest); const v = resolve(name, ctx);
//   const out = isEmpty(v) ? fallback : stringify(v); return filters.reduce((s, f) => FILTERS[f](s), out);
```

`templateVariables()` and `missingVariables()` use `splitPipes` too, so a filter is never read as a fallback. One corner case: a fallback that is literally one of the filter words (`|lowercase`) now acts as a filter.

### 17.3 `{% %}` tags, `==` and quoted spintax

These are rewritten into the native syntax **before** spintax runs, so the evaluation order in the header comment doesn't change.

```ts
export function normalizeTemplate(t: string): string {
  return t
    .replace(/\{\{\s*"([^"{}]*\|[^"{}]*)"\s*\|\s*spintax\s*\}\}/g, '{$1}')                         // {{ "a|b" | spintax }} → {a|b}
    .replace(/\{%-?\s*if\s+([a-zA-Z0-9_.]+)\s*==\s*"([^"{}%]*)"\s*-?%\}/g, '{{#if $1 == "$2"}}')
    .replace(/\{%-?\s*if\s+([a-zA-Z0-9_.]+)\s*-?%\}/g, '{{#if $1}}')
    .replace(/\{%-?\s*else\s*-?%\}/g, '{{else}}')
    .replace(/\{%-?\s*endif\s*-?%\}/g, '{{/if}}');
}
```

- `renderTemplate`, `spintaxInfo`, `templateVariables` and `missingVariables` call `normalizeTemplate` first.
- `COND_RE` accepts an optional `== "value"`: `\{\{\s*#if\s+([a-zA-Z0-9_.]+)(?:\s*==\s*"([^"]*)")?\s*\}\}`. With a value, the branch is true when the resolved text equals it (trimmed, case-insensitive, the same as Condition rules). Without one, it uses `isFalsy` from Part A §3.
- `{{#if}}` paths go through `resolve()`, so aliases work in conditions too (`{% if position %}`).
- **SQL mirror:** add `outreach_template_normalize(text)` with the same five `regexp_replace` calls. Call it at the start of `outreach_spintax_info`, so the server's length check counts `{{ "Hey|Hello" | spintax }}` as spintax. Also call it in `outreach_sequence_ai_keys` (§19.4).

---

## 18. Built-in AI variables

There are three system variables. They tidy a field the lead already has, so they never need review.

| Key | Source fields | What it returns | Example |
|---|---|---|---|
| `contact_first_name` | `first_name`, `full_name` | The name a colleague would use. Titles, credentials, emojis and pronouns are removed and capitalisation is fixed | `DR. PRIYA SHARMA, MBA 🚀` → `Priya` |
| `company_conversation` | current company, `lead.company` | The company as people say it. Legal suffixes, taglines and "The" are removed, and all-caps is fixed unless it's an acronym | `Acme Technologies Pvt. Ltd. \| We build…` → `Acme` |
| `position_conversational` | current title, `lead.title` | The role as it reads mid-sentence. Company names, separators, emojis and "ex-…" are removed | `VP Sales & Partnerships \| Ex-Google 🚀` → `VP of Sales` |

- **Rows:** add `builtin boolean not null default false` to `outreach_ai_variables`, and seed the three rows in every workspace. New workspaces get them from an `after insert` trigger on `outreach_workspaces`. If a workspace already has a variable with one of these keys, the seed skips it and the workspace's own variable is used. The prompts live in code (`_shared/outreach/ai.ts`, `BUILTIN_PROMPTS`). `prompt` holds a one-line description for display. A trigger blocks changing the `key`/`prompt` of a built-in and blocks deleting one. On/Off works through the existing `mode` (`review` = on, `off` = off).
- **When they're written:** the same as any AI variable. They're generated only for leads in a sequence that uses them (§19.4), and the lead waits until they're written. That's usually seconds, and it never needs a person.
- **Generating:** one small call per value (`purpose: 'ai_builtin'`, `temperature: 0`). Then a **check in code**: every word of the result must appear in the source field (case-insensitive), apart from `of, and, the, at, in, for, &`. If it passes, call the new service function `outreach_ai_value_result_builtin(p_id, p_text, p_model)`, which sets `text`, `status = 'approved'`, `approved_by = null` and `generated_at`, then calls `outreach_release_waiting`. If it fails or comes back empty, call `outreach_ai_value_result(p_id, null, …)`, which stores the value as blank. The alias then falls back to the raw field (§17.1).
- **Hub:** built-ins never reach Needs you, because their status never becomes `generated`. They're also left out of Activity: patch the Personalized lines branch of `outreach_ai_outputs` with `and not av.builtin`. In AI → Setup → Personalized lines they show as three read-only rows with an On/Off switch.

---

## 19. Data

### 19.1 Schema (`066_insert_variables.sql`)

```sql
alter table outreach_ai_variables add column if not exists builtin boolean not null default false;
alter table outreach_senders      add column if not exists label text;          -- optional; sender settings gets one "Label" input

create table if not exists outreach_companies (
  id                    uuid primary key default gen_random_uuid(),
  workspace_id          uuid not null references outreach_workspaces(id) on delete cascade,
  linkedin_id           text,                 -- numeric LinkedIn company id
  public_identifier     text,                 -- slug
  name text, domain text, website text, phone text, industry text,
  size text,                                  -- employee range, e.g. '51-200'
  employees_on_linkedin int, founded_year int, tagline text, about text,
  specialties text[], hashtags text[], followers int,
  hq_city text, hq_region text, hq_country text, hq_address text,
  fetched_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (workspace_id, linkedin_id)
);
create index if not exists outreach_companies_ws_domain_idx on outreach_companies(workspace_id, lower(domain));
alter table outreach_companies enable row level security;   -- same policies as outreach_lead_profiles (workspace members read; service writes)
```

### 19.2 Render context (`outreach_render_context`, patched in place like 063)

| Key | Added |
|---|---|
| `lead` | `tags` (tag names joined `, `) and `work_email_domain` (`split_part(email_work, '@', 2)`), merged into the lead object |
| `sender` | `email` (a mailbox sender's `public_identifier`; for a LinkedIn sender, its first child mailbox via `parent_sender_id`, else `owner_email`) and `label` |
| `account` | The current company's row (match on the current experience's `company_id`, else `lead.company_id`, else `domain = lead.company_domain`). Keys: `id, name, domain, website, linkedin_url, linkedin_id, phone, industry, size, founded_year, tagline, about` (first 600 chars)`, specialties, hashtags, followers, employees_on_linkedin, hq{city,region,country,address}` |
| `now` | `day, month, weekday, year, time_of_day`, in the lead's `location_timezone`, else the sender's `timezone`, else UTC. `time_of_day`: 05–11 `morning`, 12–16 `afternoon`, otherwise `evening` |

**`outreach_lead_enrich_ctx`** (copy the live definition, then add these keys; `jsonb_strip_nulls` stays):

| Key | Built from |
|---|---|
| `sn_id` | `p.linkedin->>'sales_navigator_id'`. Confirm the key name on a Sales Navigator profile fetch; empty until then |
| `last_enrich_at` | `to_char(p.enriched_at, 'Mon DD, YYYY')` |
| `twitter_url` / `facebook_url` | `p.linkedin->'socials'`, type `twitter`/`x` or `facebook`. A bare handle becomes `https://x.com/<handle>` or `https://facebook.com/<handle>` |
| `phone` | `p.linkedin->'phones'->>0` |
| `location_city / region / country` | `lead.location` split on commas. 3 parts → city, region, country. 2 parts → city, country. 1 part → city only. Country falls back to the profile's country code, via `outreach_country_name(code)` |
| `location_timezone` | `outreach_country_tz(country)`: a small constant map for single-timezone countries (IN, GB, DE, FR, AE, SG, …). Multi-timezone countries (US, CA, AU, BR, RU, MX, ID) stay empty |
| `current_started_on` | `to_char(p.current_started_on, 'Mon YYYY')` |
| `current_duration` | `2 yrs 3 mos` / `1 yr` / `8 mos` |
| `experience_summary` | Up to 3 `experience` entries: `title at company (2019–2022)`, with the current one shown as `–present`, joined by `; ` |
| `education_field` | `p.education->0->>'field'` |
| `education_summary` | Up to 2 entries: `degree, field — school`, joined by `; ` |
| `last_3_posts` | Up to 3 `p.posts` texts, newest first, 280 chars each, separated by a blank line |

### 19.3 Fetching the company

- **Where:** in the enrichment save path (`_shared/outreach/enrich.ts`). After a profile is saved, call `ensureCompany(sender, lead)`.
- **What it does:** it takes the current experience's `company_id` (else `lead.company_id`). It skips the fetch when a row for that company has `fetched_at` within the last 90 days. Otherwise it calls `unipile.linkedin.company(accountId, id)`, which already exists in `unipile.ts`, and upserts `outreach_companies`.
- **Budget:** reserve the same budget kind `resolveCompany` uses (`search_page`) before the call. With no budget left, skip; the next enrichment tries again. A company is shared by every lead who works there, so this is about one call per company, not per lead.
- **Mapping:** keep it in one function, `companyFacts(p)`, next to `profileFacts`. Build it from the first real response. Fields Unipile doesn't return stay empty.
- **No waiting:** leads don't wait for company data, just as they don't wait for profile data today. The Account tab footer says *"Add a fallback: not every company has every field."*

### 19.4 Other SQL

- **`outreach_sequence_ai_keys`:** run `outreach_template_normalize` on the graph text first. Add the built-ins with one more pattern, `\mai_(contact_first_name|company_conversation|position_conversational)\M` → that key. Keep Part A §5's two patterns. Mirror it in `sequenceAiKeys()` in `graph.ts`.
- **`outreach_spintax_info`:** normalize first (§17.3).
- **`outreach_ai_outputs`:** `and not av.builtin` (§18).

---

## 20. Builder checks

- **Known names:** the known-variable list (`nodes.ts`, the list after `TEMPLATE_VARIABLE_GROUPS`) gains every name in `VARIABLE_ALIASES`. Without that, the new names would be flagged as unknown.
- **Preview:** "Preview as lead" and its missing-variable list work unchanged, because they call the same `renderTemplate` / `missingVariables`.
- **Unknown filters:** a filter that doesn't exist (`| lowrcase`) is treated as a fallback, which is today's behaviour. Add a warning, `W_TEMPLATE_UNKNOWN_FILTER`, when that segment is one edit away from a filter name.
- **MCP:** add one paragraph to the outreach skill text (`skills.gen.ts`). It lists the new names, the filters, `{% if %}` with `==`, and quoted spintax, so templates written through the MCP use them correctly.

---

## 21. Rollout (Part B)

1. `066_insert_variables.sql`: the schema, the patches, the built-in seed and the country maps.
2. `render.ts` (both copies) and the render test.
3. `enrich.ts` (`ensureCompany`), `outreach-ai-variables` (the built-in path) and `ai.ts` (`BUILTIN_PROMPTS`).
4. UI: the Insert Variables popup in `TemplateField`, and the Label input in sender settings.

There is no backfill. Company rows fill in as leads are enriched. `now_*`, aliases and filters work as soon as the renderer ships.

---

## 22. Tests (Part B)

**Render**
- Every name in §16 resolves against a fixture context. Each alias with a list falls back to its next path when the first is empty.
- `{{ position | lowercase }}` → `head of growth`.
- `{{ position | capitalize_each_word | plural }}` → `Heads Of Growth`.
- `{{ position | lowercase | there }}` with an empty title → `there`.
- `plural`: `CEO` → `CEOs`, `Sales` → `Sales`, `Head of Growth` → `Heads of Growth`, `Company` → `Companies`.
- `{% if first_name == "john" %}A{% else %}B{% endif %}` with `John` → `A`, and with `Priya` → `B`.
- `{{ "Hey|Hello|Bonjour" | spintax }}` picks the same option as `{Hey|Hello|Bonjour}` for the same seed.
- A value containing `{% if x %}` is printed literally, because values are never re-scanned.
- Old syntax renders exactly as before, across the existing render test suite.
- The two copies are identical.

**SQL**
- `outreach_spintax_info` gives the same max length for quoted and native spintax.
- `outreach_sequence_ai_keys` finds `contact_first_name` from `{{ ai_contact_first_name }}`.
- `outreach_render_context` returns `account` for a lead whose company row exists, and `now` in the lead's timezone, else the sender's.
- `sender.email` for a mailbox sender and for a LinkedIn sender with a child mailbox.
- Enrich ctx: location split for 1, 2 and 3 parts; `current_duration`; `experience_summary` with a current role.

**Built-ins**
- `DR. PRIYA SHARMA, MBA` → `Priya` is approved.
- A result with a word not in the source → blank, and the template shows the raw `first_name`.
- Built-ins never appear in Needs you or Activity.
- Off → the raw field is used.

**Company fetch**
- Fetched once per company per 90 days. Skipped when the `search_page` budget is empty.
- Two leads at one company share one row.

**Popup**
- Search `email` shows matches in Contact and Sender Profile with counts. A tab with no matches switches to the first tab that has some.
- Click inserts at the cursor. A selection is wrapped by a `{% if %}` row.
- Email-only rows are hidden on LinkedIn steps. The `if`/spintax rows are hidden in plain fields.
- Examples match Preview for the same lead. With no preview lead, samples show in grey.
- Esc closes, and ↑/↓/Enter work.
