# List building from a file (CSV / XLSX / Sheets export)

Clients with a filesystem (Claude Code, Cowork) are the preferred path for list building: cleaning happens where the operator can see it, and only validated rows cross the wire.

## 1. Parse and normalise locally
For each row build a lead object with only the keys you have:

| Field | Rule |
|---|---|
| `linkedin_url` / `public_identifier` | Any `linkedin.com/in/<slug>` URL → the server extracts the slug; Sales Navigator (`/sales/lead/…`) and company URLs are **not** identifiers — drop them or find the /in/ URL. Lowercase. |
| `first_name`, `last_name`, `full_name` | Split "Priya Nair" → first/last if only a full name exists; keep `full_name`. Strip titles/emojis. |
| `email_work` (`email` also accepted), `email_personal` | Lowercase, trim; must match `x@y.tld`. Free-mail domains (gmail, yahoo…) belong in `email_personal`. |
| `headline`, `company`, `title`, `location` | Trim; ≤ 300 chars. |
| `custom` | Anything else worth keeping (`{"segment":"fintech","source_row":12}`) — usable in copy as `{{custom.segment}}` and in conditions. |
| `client_id`, `list_id`, `stage_id` | Optional; ids from `workspace_context`. |

A row needs a LinkedIn slug **or** an email; rows with neither are rejected (`E_NO_IDENTIFIER`) — list them for the operator instead of guessing.

## 2. Validate without writing
`lead_upsert(leads, dry_run:true)` in batches of ≤ 500. It returns `valid`, `would_create`, `would_update` (already in the workspace — those rows get enriched, never overwritten) and per-row `errors` `{row_index, code, field, message}`. Fix what you can locally (bad emails, malformed URLs); report the rest.

Tell the operator: total rows, would create, would update, rejected (with reasons), and any obvious duplicates inside the file itself. Wait for approval.

## 3. Write
`lead_upsert(leads, source:"csv:<filename>")` per batch of ≤ 500 (bulk quota: 60 calls/hour ≈ 30,000 leads). Per-row failures do not stop the batch; collect `ids` from each response.

## 4. Organise
- `lead_set_list(lead_ids, list:"<name>", create_if_missing:true)`
- `lead_tag(lead_ids, add:["<campaign tag>"])`
- Optionally `lead_set_stage(lead_ids, stage:"New")`.

## 5. Hand-off
Report: created / updated / failed counts, the list and tag names, and — if a campaign follows — the `leads_search` filter that selects exactly this list (`list_id`) for `enroll_preview`.

## When to use the platform importer instead
- A LinkedIn people-search URL → `import_create(kind:"search_url", url, sender_id, max_results)`; gated; consumes that sender's `search_page` budget (10 or 50 profiles per page) over several days; `import_status(job_id)` to follow.
- The sender's own connections → `import_create(kind:"relations", sender_id)`.
- A CSV already uploaded by the app to the `outreach-imports` bucket → `import_create(kind:"csv", storage_path, mapping, row_count)`; for local files prefer `lead_upsert`.
