---
name: capitalxai-admin
description: Manage the CapitalxAI investor database via its MCP connector (admin accounts). Use when the user wants to add or update investor firms/people, link people to firms, record or update funding rounds, or research an investor (domain/LinkedIn/name) in the browser and add them end-to-end — and the CapitalxAI connector write tools (add_investor, update_investor, mark_not_an_investor, add_funding, update_funding) are available alongside the read tools.
---

# CapitalxAI (admin)

CapitalxAI is a fundraising intelligence app with a shared database of investors (firms and people) and recent funding rounds. This skill covers the full connector, including the write tools that only admin accounts have.

**Distribution note: this skill is for admin users only — do not install or share it with non-admin users.** The connector itself only registers write tools for admin accounts; if the write tools are missing, the connected account is not an admin, and you should work with the read tools only (see the `capitalxai` skill) without referencing admin capabilities.

## Tools at a glance

| Tool | What it does | Access |
|---|---|---|
| `find_investors` | Search investors by name, firm domain, or LinkedIn URL; returns ids | Any user |
| `add_investor` | Add a firm (by domain) or person (by LinkedIn), with optional profile fields | Admin |
| `update_investor` | Update fields on an existing investor; link a person to a firm | Admin |
| `list_fundings` | Recent funding rounds, newest first, with search and paging | Any user |
| `get_funding` | Full record of one funding (complete founders/investors lists) | Any user |
| `add_funding` | Record a funding round; upserts by company domain | Admin |
| `update_funding` | Update fields of an existing funding row | Admin |
| `mark_not_an_investor` | Record a researched entity as NOT an investor so future research skips it | Admin |

## Researching and adding an investor end-to-end

When the user gives an investor to research and add (a domain, LinkedIn URL, or name) rather than ready-made data, read [research-pipeline.md](research-pipeline.md) and follow it exactly — it encodes the app's classify → deep-research → extract → write pipeline, including the not-an-investor rules and the person→firm recursive add. The exact field formats and allowed enum values for every write are in [extraction-schema.md](extraction-schema.md); read it before any `add_investor`/`update_investor` call that fills profile fields, even outside a research run.

## Data conventions (important)

- **Identity**: firms are identified by `domain` (bare, lowercase, no www — `accel.com`), people by `linkedin_url`. Full URLs are accepted everywhere; the server strips protocol/`www.` and stores LinkedIn as a path (`in/naval`). A firm must have a domain; a person must have a LinkedIn URL.
- **Money** is a plain USD integer: `5000000` means $5M. Never pass strings like "$5M".
- **Dates** go in as `YYYY-MM-DD`. When talking to the user, show readable dates ("June 15, 2026"), never raw ISO stamps.
- **Linked-name lists** (`founders`, `investors`, `notable_investments`, `coinvestors`, `work_experience_orgs`, `education_orgs`) are arrays of `"[Name](url)"` strings — the url is the **firm domain** for organizations and the **LinkedIn URL** for individuals, e.g. `["[Accel](accel.com)", "[Naval Ravikant](linkedin.com/in/naval)"]`.
- Investor `tier` is `A`, `B`, or `C`. `investor_type` is an array like `["VC"]`, `["Angel"]`, `["Family Office"]`.

## Workflows

### Adding an investor firm
1. Check first: `find_investors` with the firm's domain (or name). If it exists, switch to `update_investor` instead of adding.
2. `add_investor` with `type: "firm"`, `name` (clean, no legal suffixes: "Accel", not "Accel Partners LP"), and `domain`.
3. Include whatever profile fields the user provided: `investor_type`, `tier`, `hq_state`/`hq_country`, `fund_size_usd`, `check_size_min_usd`/`check_size_max_usd`, `investment_stages`, `investment_industries`, `investment_geographies`, `investment_thesis`, `notable_investments`, `leads_round`, `email`, `twitter_url`, `links`.
4. Do not invent field values the user didn't give you — leave unknown fields out.

### Adding an investor person
1. Check first with `find_investors` (LinkedIn URL or name).
2. `add_investor` with `type: "person"`, `name`, and `linkedin_url`. Person-specific fields: `role` ("Partner at Accel"), `work_experience_orgs`, `education_orgs`.
3. If the person belongs to a firm, pass `firm_domain` — it links them to that firm automatically. If the tool replies that the firm doesn't exist yet, add the firm first, then call `update_investor` on the person with `firm_domain` to create the link.

### Updating an investor
1. Locate with `find_investors` and prefer passing the returned `investor_id` to `update_investor` (domain/linkedin_url also work as locators).
2. Pass **only** the fields to change; everything else is left untouched. Array fields replace the stored value entirely.
3. `new_domain` / `new_linkedin_url` change the identity fields; use them only when the user explicitly asks to correct a domain or LinkedIn URL.

### Recording a funding round
1. `add_funding` with `name`, `domain`, `how_much_funding` (USD number), `funding_date` (`YYYY-MM-DD`), `investors`, `founders`, `what_they_do`, `usp`, `founded_in_year` — whatever the user has.
2. Always pass the company `domain` when known: fundings are deduplicated by domain, so re-adding the same company **updates** its row instead of creating a duplicate. The tool reply says whether it added or updated.
3. The `investors` list should cover all investors from earliest to latest round, not just the new round, when the user has that information.

### Updating a funding
1. Find the row with `list_fundings` (search by name or domain), then `get_funding` for the full current record.
2. `founders` and `investors` are **full replacements**: to add one investor, take the current list from `get_funding`, append the new entry, and send the whole list to `update_funding`. Same for removals.
3. Scalar fields (`how_much_funding`, `funding_date`, `what_they_do`, ...) can be updated directly without reading first.

## Conventions

- Always confirm what was written by echoing the tool's reply (created vs updated, which fields changed, the record id).
- Before bulk additions (more than ~5 records), show the user a short preview of the parsed records and get a confirmation, then proceed one call at a time so individual failures are visible.
- If a lookup finds nothing, say so and offer the add tool rather than silently creating records the user didn't ask for.
- If a tool returns an authorization error, the connector needs to be reconnected: tell the user to re-connect CapitalxAI in their Claude connector settings.
- Never fabricate investor data (fund sizes, theses, portfolio companies). Only write what the user supplied or what a source they provided states.
