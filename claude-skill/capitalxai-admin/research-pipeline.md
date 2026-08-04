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

**Resolve redirects before any lookup**: open (or fetch) the given domain and use the domain it finally lands on — `tenvc.com` redirecting to `10vc.com` means the canonical identity is `10vc.com`. The server also does this on writes and keeps old domains in `alt_domains`, but doing it up front prevents the whole duplicate class.

Then check for existing records **three ways**: `find_investors` by domain (also matches `alt_domains`), by LinkedIn URL (matches `in/username` against stored `in/username-xyz123` variants), **and by name** (`query`) — a duplicate usually differs on exactly the identifier you searched by.

- **One match** → this becomes an *update/refresh* run: still research (steps 2–3), but finish with `update_investor`, passing only fields that are empty or clearly outdated. Never overwrite a filled field with a lower-confidence value.
- **Multiple records for the same entity** (same LinkedIn, or old + new domain): these are duplicates. Determine which record has the canonical identity (the domain the website actually resolves to), verify with `get_investor` on both, then `merge_investors(keep_id, drop_id)` — keep the canonical/richer record. Report the merge. Use `delete_investor` only for records that are outright wrong (not duplicates of anything).
- **Reply says it is marked NOT an investor** → it was researched and rejected before. Tell the user and stop, unless they explicitly override.
- Otherwise → continue to add.

**Identity corrections**: when a primary source directly contradicts a stored identity field (the LinkedIn on the firm's own site differs from the stored one; the domain redirects elsewhere), correct it via `update_investor` (`new_domain` / `new_linkedin_url`) without waiting to be asked — and state the change and its source in your report. The server blocks the change if another record already owns that identity (that's your cue to merge instead).

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

Act as a research analyst. The app's version of this step is a search-grounded AI (Gemini with Google Search) — match that breadth: combine **web searches** ("<name> fund size", "<name> check size", "<name> interview") with **opening tabs** across the firm site, LinkedIn, a data source (Crunchbase/Dealroom/PitchBook public pages), recent news, interviews/podcasts. Cover this checklist — it is the app's research brief:

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

**⚠ Directory-site hallucination — the highest-risk trap in this pipeline.** Aggregator/directory sites (SuperScout, VCSheet, Signal, and similar) routinely conflate a partner's *personal track record* with the *firm's portfolio* — a two-person fund "showing" Anduril or Remitly is almost always the partner's bio leaking into the firm page. Rules:
- A famous company at a small/young fund should trip an alarm: verify on the firm's **own** portfolio page or a funding announcement naming the firm before recording it in `notable_investments`.
- If only directories claim it, it belongs (at most) in the **person's** background (`work_experience_orgs` / their record), never in the firm's portfolio.
- **Verify portfolio company domains by opening them** — directory URLs are frequently wrong; the firm's own portfolio page resolves this in seconds.

**Exits and rounds feed the fundings table**: when research surfaces an exit, record it in the investor's `exits` field (`"[Company](url)"` strings), and when it surfaces a funding round for a portfolio company (amount + date + investors), also upsert that round with `add_funding` — high-signal facts must not live only as prose inside `deep_research`.

**Provenance**: pass `sources` on the write — a map of field → source URL for the load-bearing fields (fund size, check sizes, emails, portfolio) — so every value carries `source_url` + `verified_at` and future runs can tell verified data from stale guesses.

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

## Refresh runs ("update the research for X")

A refresh is distinct from add/update: the record exists and the goal is bringing it current. `find_investors` shows `researched: <date>` on every result, and `stale_older_than_days` finds records due for a sweep ("refresh everyone older than 90 days").

1. `get_investor` for the current record; note `last_researched_at` and `field_sources` (what was verified, when).
2. Re-verify the identity: does the domain still resolve to itself? Is the LinkedIn still right?
3. **Re-verify portfolio domains by opening them** — companies rebrand, die, and get acquired between runs.
4. Re-check the team roster against the firm's team page (roster run below) — flag departures, add new partners.
5. Sweep for what changed since the last research date: new funds raised, new deals, exits, role changes. Update `exits`, and feed new rounds to `add_funding`.
6. `update_investor` with only the changed/new fields + refreshed `deep_research` + `sources`, and `mark_researched: true` (automatic when deep_research is included). Use `clear_fields` for values that turned out to be wrong (e.g. a bogus `twitter_url`) rather than overwriting with guesses.

## Populating a firm's team (roster run)

When a firm exists but has no (or few) people linked — or the user asks to "add the team/partners at X":

1. **Check who's already linked**: `find_investors` with `at_firm_domain` set to the firm's domain. This lists the currently affiliated people so you never re-add them.
2. **Build the roster in the browser**: open the firm's team/people page and its LinkedIn company page → People. Collect each member's name, LinkedIn URL, and title. Apply the **same inclusion rules as the app's contact fetcher** (the investor-search edge function):
   - **Include** anyone whose title contains or is similar to: ceo, founder, co-founder, partner, managing partner, general partner, principal, venture partner, operating partner, independent investor, angel investor, associate, research analyst, scout, investment, investor — or whose seniority is founder/owner/C-suite/VP/head/director/partner. ("Head of Investments", "Investment Manager", "VP of Platform" qualify.)
   - **Exclude** anyone whose title contains a deny keyword: data scientist, machine learning, ml engineer, graphic designer, video editor, product designer, illustrator, photographer, risk officer, growth marketing, account executive, recruiter, people ops/people operations, admin/administrative, assistant/executive assistant, office manager, econometrics, public policy, general counsel, software/frontend/backend/platform engineer, product/program/project/delivery manager, product management, scrum master, agile coach, art director, creative director, copywriter, social media, community manager, video producer, public relations, demand generation, performance marketing, customer success, customer support, support specialist, paralegal.
   - When writing each person, their `role` field still takes the nearest value from the role enum in the schema file.
3. **Confirm the roster with the user** before adding (names + titles + count) — a firm can have dozens of people and each one gets a full research pass.
4. **Process one person at a time** through the standard pipeline above, always passing `firm_domain` so the affiliation is created. If a person already exists in the DB but isn't linked, just call `update_investor` with their id and `firm_domain` — that creates the missing link without touching other fields.
5. **Re-check** at the end with `find_investors` + `at_firm_domain` and report the final linked count.

Depth note: for large rosters, agree a depth with the user — "link only" (name, LinkedIn, role, firm_domain — fast) vs "full profile" (complete research pass per person). Default to full profile for partners and link-only for associates/analysts if the user doesn't specify.

## Batch runs

For a list of investors, confirm the list with the user first, then process **one investor at a time** through the full pipeline so failures are visible and each record gets a real research pass. Report a per-item summary (added / updated / skipped-exists / not-an-investor / failed) at the end.
