# CapitalxAI investor research pipeline (browser)

This replicates the app's automated investor-research pipeline (classify → deep research → extract → write), with you doing the research in the browser instead of the app's APIs. The output must land in the database in **exactly** the app's structure, so follow the field formats and checking rules strictly. Read [extraction-schema.md](extraction-schema.md) before writing any record — every enum value and format lives there.

Requires browser/web research capability. If browser tools are unavailable, say you can't do the research part and offer to record data the user provides instead.

## Inputs

Accept any of: a firm domain (`accel.com`), a LinkedIn URL (`linkedin.com/in/naval`, `linkedin.com/company/accel`), or a person/firm name. A bare name is not an identifier — first find the person's LinkedIn or the firm's website in the browser, confirm with the user if ambiguous, then proceed with that identifier.

Normalize before every lookup or write:
- Domain: bare lowercase, no protocol/www/path → `accel.com`. A LinkedIn URL is **never** a domain.
- LinkedIn: path form, lowercase → `in/naval`, `company/accel`. A plain website domain is **never** a person's LinkedIn.

## Pipeline

### 1. Duplicate & skip-list check — always first

Call `find_investors` with the domain (firms) or LinkedIn URL (people; the tool also matches `in/username` against stored `in/username-xyz123` variants).

- **Exists already** → this becomes an *update* run: still research (steps 2–3), but finish with `update_investor`, passing only fields that are empty or clearly outdated. Never overwrite a filled field with a lower-confidence value.
- **Reply says it is marked NOT an investor** → it was researched and rejected before. Tell the user and stop, unless they explicitly override.
- Otherwise → continue to add.

### 2. Classification (mirrors the app's Step 1)

Open the subject in the browser: for a firm, the website plus its about / portfolio / team / contact / thesis / investments / apply pages (the app samples exactly these subpages); for a person, their LinkedIn profile and personal site if any.

Decide, based **only on visible page content — do not infer or assume**:

1. `entity_type`: **Person** (individual acting under their own name) or **Organization** (company, fund, firm, structured entity).
2. `is_investor`: does the subject clearly invest capital? **If no investment activity is clearly stated on what you can see, classify as Not an Investor.** Consulting firms, agencies, SaaS companies, media brands, and "we help startups" service providers are not investors.
3. `investor_types`: one or more values from the fixed list in the schema file (e.g. `Venture Capital`, `Angel Investor`, `Family Office`). Multiple types are allowed.
4. `clean_name`: display name with legal suffixes, fund numbers, and marketing taglines removed ("Accel", not "Accel Partners LP" or "Accel — backing global startups").
5. `links`: collect the key subpage URLs you visited as `[title](url)` strings — they are written to the record.

**Not an investor** → call `mark_not_an_investor` with the domain/LinkedIn and a one-line reason, report it, and stop. Do not add the record.

### 3. Deep research (mirrors the app's Step 2)

Act as a research analyst. Open tabs across: the firm site, LinkedIn, a data source (Crunchbase/Dealroom/PitchBook public pages), recent news, interviews/podcasts. Cover this checklist — it is the app's research brief:

- Background and career/professional history; for people: companies they worked at and schools attended
- Contact details: verified emails, LinkedIn URL, Twitter/X URL
- Best way to approach or pitch — an apply/submission/form URL if one exists
- Current fund/firm (name + domain), the person's role, HQ state and country
- Investment stages, check size min/max, fund size, lead vs follow-on
- Industry and technology focus; geographic preferences
- Notable investments, portfolio companies, exits
- Co-investors they back deals with (firms and individuals)
- Recent deals/activity; public quotes or essays revealing investment philosophy

Note the source URL for every fact. **Record only what a source states — never invent fund sizes, check sizes, theses, or portfolio companies.** A field with no confident source stays empty.

### 4. Extraction & validation (mirrors the app's Step 3)

Map findings into the exact formats in [extraction-schema.md](extraction-schema.md). Non-negotiable rules:

- Leave out any field you cannot confidently support; do not guess.
- `investment_stages`, `investment_industries`, `role` take **only** values from their fixed lists — pick the nearest slugs, never free text.
- Money fields are USD integers (`500000000`, never "$500M").
- `investment_thesis` starts with "Invests in...".
- Name lists are `"[Name](url)"` strings — url is the firm **domain** for organizations, the **LinkedIn URL** for individuals.
- `apply_url` only if it is a real application/submission page, not the homepage.
- Grade `tier` A/B/C per the rubric in the schema file.

### 5. Write to CapitalxAI

**Firm**: `add_investor` with `type: "firm"`, `name`, `domain`, and every extracted field.

**Person**: the app always attaches people to their firm — do the same:
1. If research found a current firm, `find_investors` for the firm's domain.
2. Firm missing → **run this entire pipeline for the firm first** (classify → research → add). This is exactly what the app does when adding a person whose firm is unknown.
3. Then `add_investor` with `type: "person"`, `name`, `linkedin_url`, `firm_domain` (creates the affiliation), `role`, and the rest.

**Existing record** (step 1 found it): `update_investor` by `investor_id` with only the new/missing fields.

The server enforces the identity rules too (rejects LinkedIn paths as domains and vice versa) — if a write is rejected, fix the data rather than retrying with the same values.

### 6. Report

Tell the user: added vs updated (with record id), firm/person and affiliation created, the key extracted fields (tier, stages, check sizes, thesis one-liner), which fields stayed empty for lack of sources, and the main source links.

## Batch runs

For a list of investors, confirm the list with the user first, then process **one investor at a time** through the full pipeline so failures are visible and each record gets a real research pass. Report a per-item summary (added / updated / skipped-exists / not-an-investor / failed) at the end.
