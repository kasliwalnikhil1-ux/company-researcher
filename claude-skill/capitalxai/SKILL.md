---
name: capitalxai
description: Browse the CapitalxAI investor database and analyze investor fit for your company via its MCP connector. Use when the user wants to look up investor firms/people, explore recent funding rounds, or analyze whether investors are a fit for their company ("Analyze accel.com for my company", "Find fit investors for..."), and the CapitalxAI connector tools (find_investors, get_investor, list_fundings, get_funding, get_analysis_context, save_investor_analysis) are available.
---

# CapitalxAI

CapitalxAI is a fundraising intelligence app with a shared database of investors (firms and people) and recent funding rounds. This skill explains how to use its MCP connector tools well. All tools require the user to have connected the "CapitalxAI" connector (they log in with their CapitalxAI account and approve access).

## Tools at a glance

| Tool | What it does |
|---|---|
| `find_investors` | Search investors by name, firm domain, or LinkedIn URL — or by filters (stages, industries, geographies, tier) |
| `get_investor` | One investor's full record, including their research profile |
| `list_fundings` | Recent funding rounds, newest first, with search and paging |
| `get_funding` | Full record of one funding (complete founders/investors lists) |
| `get_analysis_context` | Your company data + the prompt templates used for fit analysis |
| `list_analyzed_investors` | Investors you already analyzed, with their stored fit verdicts |
| `save_investor_analysis` | Save a fit result + outreach lines to your account's personalization |

## Data conventions

- Firms are identified by `domain` (bare, lowercase, no www — `accel.com`), people by their LinkedIn URL. Full URLs are accepted; the server strips protocol/`www.` automatically.
- Funding amounts are USD numbers: `5000000` means $5M. Present them readably ("$5M", "$12.5M").
- Show dates in readable form ("June 15, 2026"), never as raw ISO stamps like 2026-06-15.
- Linked-name lists (`founders`, `investors`) come back as `{name, url}` pairs — the url is the firm domain for organizations and the LinkedIn URL for individuals. Show them as plain links.

## Workflows

### Looking up an investor
1. `find_investors` with whichever identifier the user gave: a name (`query`), a firm domain, or a LinkedIn URL. Use `type` to narrow to only firms or only people, or the filter parameters (`stages`, `industries`, `geographies`, `tier`, `investor_type`) for criteria-based searches.
2. Results include tier, investor type, role, and country when known. `get_investor` returns the full profile. If nothing matches, say so — don't guess or fabricate investor details.

### Exploring fundings
1. `list_fundings` for a feed of recently funded companies; use `search` to filter by company name or domain.
2. Page with `offset` when the user wants more (the reply says how many exist in total).
3. For one company's full picture — all founders, all investors, USP, founding year — call `get_funding` with its domain or id.

### Analyzing investor fit (the app's "Analyze with AI")
When the user says "Analyze accel.com for my company", "Analyze domains X, Y, Z", or "Find fit investors for my company":

1. `get_analysis_context` once. It returns the company name, onboarding/company data, plan, and the **exact prompt templates** to use (the account's custom templates when set). Build the company context strictly from the onboarding data — no invention.
2. `list_analyzed_investors` once, and **skip investors that already have a saved analysis** — re-analyze only when the user explicitly asks ("re-analyze accel.com"); saving overwrites the stored result. Note skips in the report ("already analyzed — fit").
3. Candidate set — investors are classified as **firm** or **person**, analyzed separately: explicit domains (= firms) and LinkedIn URLs (= that record) are unambiguous → `get_investor` each. A bare **name** is ambiguous ("Analyze Accel" could be the firm or one of its partners): `find_investors` by name and if matches span both types or multiple records, **ask which to analyze** before proceeding — never pick silently. "Find fit investors" → ask whether firms, people, or both (pass `type`), then `find_investors` with filters derived from the company (stage, industry, geography) plus `has_deep_research: true`; confirm scope if open-ended (start with ~15–25).
4. Per investor, analysis runs on the `deep_research` text from `get_investor` — an investor without it cannot be analyzed; skip and report it.
5. You are the analysis AI. Apply the templates exactly: replace `<<COMPANY_NAME>>>` / `<<<COMPANY_NAME>>>` with the company name, `<<<COMPANY_CONTEXT>>>` with your company summary, `<<<DEEP_RESEARCH>>>` with the investor's research text. Produce exactly: `investor_fit` (true/false/null), a short precise `reason`, two outreach lines following the exact sentence structures ("I saw you ..., which is why I'm reaching out to you about <company>." / "I believe ... could greatly benefit us at <company>." — insertions under 12 words), and up to 2 non-generic `mutual_interests`. Judge honestly — stage/industry/geography/check-size mismatches are a `false` with the mismatch named.
6. `save_investor_analysis` immediately after each investor (interleave analyze→save). The results appear in the app exactly as if "Analyze with AI" had been clicked.
7. Report a compact table: investor → fit (✓/✗/?) → one-line reason, plus any skipped for missing research data.

## Conventions

- Never fabricate investor data (fund sizes, theses, portfolio companies). Report only what the tools return, and cite the company/investor names as they appear in the database.
- If a tool returns an authorization error, the connector needs to be reconnected: tell the user to re-connect CapitalxAI in their Claude connector settings. Preserve any analyzed-but-unsaved results in your reply so they can be saved right after reconnecting.
