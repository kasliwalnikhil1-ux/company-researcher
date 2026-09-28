# CapitalxAI new-fundings discovery pipeline

Recurring (or on-demand) run that discovers recently funded companies, researches each one, and upserts them into `new_fundings` via the connector. Mirrors the app's funding-research format exactly — the same fields the "Add New Funding" flow produces.

**This pipeline is autonomous.** Process EVERY announced round you discover, across ALL sectors — do not filter by industry and do not stop to ask the user which candidates to research. The only time to narrow is when the user explicitly gave a filter up front ("only AI rounds", "India only"). Asking "which should I add?" defeats the point: the same pipeline runs unattended on a schedule.

## 0. Load what's already recorded

Before discovering anything, call `list_fundings` with `limit: 30` (newest first). This gives you the most recent domains, amounts, and dates in the database — use it to drop already-recorded candidates immediately, without a lookup per candidate. It also tells you roughly where the last run left off.

## 1. Discover recent rounds

Search the web for funding announcements from roughly the **last 48 hours** (overlap is safe — fundings upsert by domain, so re-processing a company updates rather than duplicates). Sweep several sources, not one:

- Web searches: "raised seed round", "raises Series A", "announces funding round" (with recent-date filters)
- Funding news pages: TechCrunch funding coverage, Finsmes, Axios Pro Rata, EU-Startups / Tech.eu / Inc42 / YourStory (match the user's geographic focus if they stated one)
- Aggregators: Crunchbase news, Dealroom announcements

All sectors count — AI, biotech, cybersecurity, fintech, climate, consumer, everything. Collect per candidate: company name, website domain, round size, date, lead + participating investors, founders. Skip rumors and "in talks to raise" stories — only announced rounds.

## 2. Dedupe before researching

First drop candidates whose domain already appears in the step-0 list with this same round. For everything else, call `get_funding` with the company domain (the authoritative check — step 0 only covers the newest 30 rows):
- **Not found** → research and add (step 3).
- **Found with the same round already recorded** → skip.
- **Found but this is a NEW round** (newer date / larger amount) → research and update: merge the investors lists (all investors, earliest round first) and set the new `funding_date` / `how_much_funding`.

## 3. Research each company

For every company kept, gather (web search + opening the announcement article and the company site):

- `name` — clean company name without legal suffixes
- `domain` — clean domain without protocol/www
- `funding_date` — announcement date, `YYYY-MM-DD`
- `how_much_funding` — round size as a **USD integer** (`5000000` for $5M); convert other currencies at approximate current rates
- `founders` — `"[Name](linkedin_url)"` strings
- `investors` — **all investors from earliest to latest round**, not just this round: `"[Name](url)"` where url is the **firm domain** for firms and the **LinkedIn URL** for individuals
- `what_they_do` — one line
- `usp` — unique selling proposition, one line
- `founded_in_year` — integer

Only record what a source states; leave unknown fields out. Never invent amounts or investors.

## 4. Write — immediately, per company

`add_funding` with everything gathered — it upserts on domain and reports added vs updated. **Write each company right after researching it.** Never research the whole batch first and write at the end: if the connector session expires mid-run, batched writes lose everything, while research→write per company loses at most the one in progress.

**When multiple rows are already prepared** — the user hands you researched rows (a JSON file, a pasted preview from an earlier run) or you're resuming after a reconnect — do NOT loop `add_funding`: write them all in **one `add_fundings_bulk` call** (up to 50 rows, same fields, upsert-by-domain per row, per-row added/updated/error report).

If a write fails with an authorization error: stop calling tools, put every remaining researched-but-unwritten row into your reply in ready-to-write form (the `add_fundings_bulk` input shape), and tell the user to reconnect the CapitalxAI connector. After reconnecting, a single `add_fundings_bulk` call finishes the job — do not redo the research.

## 5. Missing investors check (report-only by default)

After writing, check each investor that appeared in the new fundings with `find_investors` (by domain for firms, LinkedIn for people). List the ones missing from the investors database in the report — **do not auto-add them** unless the user asked for it; adding investors properly requires the full research pipeline in [research-pipeline.md](research-pipeline.md), which is expensive per investor.

## 6. Report

End every run with a compact summary:

- Fundings added (name, domain, amount, date) and updated
- Candidates skipped (already recorded / rumor-only / no domain found)
- Investors referenced but missing from the investors DB (the follow-up work list)
- Sources consulted

On a scheduled run with nothing new found, say so explicitly — an empty result is a valid result; do not pad it by re-adding old rounds.
