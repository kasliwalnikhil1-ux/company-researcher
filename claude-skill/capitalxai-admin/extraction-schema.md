# CapitalxAI investor extraction schema

The exact field formats and allowed values, copied from the app's investor-research pipeline. Fields you cannot confidently support from a source are **left out entirely** (never guessed, never filled with placeholders).

## Identity fields

| Field | Format | Rule |
|---|---|---|
| `type` | `firm` \| `person` | Person = individual acting under their own name; Organization/company/fund → `firm` |
| `name` | string | Clean name: no legal suffixes (LP, LLC, Ltd), no fund numbers ("Fund III"), no marketing taglines |
| `domain` | `accel.com` | Bare lowercase, no protocol/www/path. Required for firms. Never a LinkedIn URL |
| `linkedin_url` | full URL or path | Required for people. Stored as path (`in/naval`). Never a plain website domain |

## `investor_type` — pick one or more, exactly these values

- `Venture Capital`
- `Angel Investor`
- `Family Office`
- `Private Equity`
- `Hedge Fund`
- `Corporate Venture Capital`
- `Accelerator / Incubator`
- `Investment Holding Company`
- `Sovereign Wealth Fund`
- `Institutional Investor`
- `Fund of Funds`
- `Venture Debt / Credit Investor`
- `Crowdfunding / Community Investor`
- `Government or Public Investment Fund`

## `role` (people only) — pick exactly one

`CEO / Founder`, `Founder`, `Founding Partner`, `Partner`, `Managing Partner`, `General Partner`, `Managing Director`, `Head of Investments`, `Principal`, `Venture Partner`, `Operating Partner`, `Independent Investor / Angel`, `Associate`, `Research Analyst`, `Scout`

Use the person's actual title when it's in this list — never round "Founding Partner" up or down to a different title. (Note: the app's automated pipeline currently knows only the shorter original list; the four added values are valid in the database.)

## `investment_stages` — pick all that apply, exactly these slugs

`pre-seed`, `seed`, `post-seed`, `series-a`, `series-b`, `series-c`, `growth`, `late-stage`, `pre-ipo`, `public-equity`, `angel`

## `investment_industries` — pick all that apply, exactly these slugs

`artificial-intelligence`, `machine-learning`, `healthtech`, `biotech`, `digital-health`, `mental-health`, `wellness`, `longevity`, `fitness`, `consumer-health`, `medtech`, `pharma`, `genomics`, `bioinformatics`, `neuroscience`, `consumer-tech`, `enterprise-software`, `saas`, `vertical-saas`, `developer-tools`, `productivity`, `collaboration`, `fintech`, `payments`, `lending`, `credit`, `insurtech`, `regtech`, `wealthtech`, `climate-tech`, `energy`, `clean-energy`, `carbon-removal`, `sustainability`, `web3`, `blockchain`, `crypto`, `defi`, `nft`, `social-platforms`, `marketplaces`, `creator-economy`, `edtech`, `hr-tech`, `future-of-work`, `mobility`, `transportation`, `autonomous-vehicles`, `robotics`, `hardware`, `deep-tech`, `semiconductors`, `data-infrastructure`, `cloud-infrastructure`, `devops`, `cybersecurity`, `security`, `privacy`, `identity`, `digital-identity`, `consumer-internet`, `ecommerce`, `retail-tech`, `proptech`, `real-estate`, `construction-tech`, `smart-cities`, `supply-chain`, `logistics`, `manufacturing`, `industrial-tech`, `agtech`, `foodtech`, `gaming`, `esports`, `media`, `entertainment`, `music-tech`, `sports-tech`, `travel-tech`, `hospitality`, `martech`, `adtech`, `legal-tech`, `govtech`, `defense-tech`, `space-tech`, `aerospace`, `iot`, `edge-computing`, `network-effects`

## `investment_geographies`

Country ISO codes where possible (`US`, `GB`, `IN`); otherwise regions: `MENA`, `APAC`, `LATAM`, `EMEA`, `North America`, `Sub-Saharan Africa`.

## Location

- `hq_state`, `hq_country`: per the ISO 3166-2 standard (e.g. state `California`/`US-CA` convention as used elsewhere in the DB; country `United States` / `US`). Match how existing records are formatted when updating.

## Profile fields

| Field | Format | Rule |
|---|---|---|
| `fund_size_usd` | integer | USD, e.g. `500000000` for $500M |
| `check_size_min_usd` / `check_size_max_usd` | integer | USD |
| `leads_round` | boolean | true if they lead rounds (lead investor), false if follow-on only |
| `active` | boolean | actively investing now |
| `investment_thesis` | string | Precise qualification criteria, **starts with "Invests in..."** |
| `notable_investments` | `["[Name](url)"]` | url = company domain |
| `coinvestors` | `["[Name](url)"]` | url = firm domain for firms, LinkedIn URL for individuals |
| `work_experience_orgs` (people) | `["[Name](url)"]` | past employers |
| `education_orgs` (people) | `["[Name](url)"]` | schools/universities |
| `email` | string | verified emails only; join multiple with `", "` |
| `twitter_url` | URL | profile URL |
| `apply_url` | URL | only a real pitch/application/submission page — never the homepage |
| `links` | `["[title](url)"]` | key site subpages visited (about, portfolio, team, contact, thesis, investments, apply) |
| `deep_research` | string | the full research write-up: structured sections with citation links, like the app's deep-research text. Always include it on research runs |
| `exits` | `["[Company](url)"]` | acquisitions/IPOs from this investor's portfolio; also feed the round itself to `add_funding` |
| `sources` (write-time) | `{"field": "https://url"}` | provenance for load-bearing fields — stored as `field_sources` with `verified_at` stamps |
| `firm_domains` (people, write-time) | `["fund1.com", "fund2.com"]` | ALL firms a multi-firm person belongs to; each gets an affiliation |
| `clear_fields` (update-time) | `["twitter_url"]` | explicitly null out wrong values instead of overwriting with guesses |

Server-managed identity fields (never set directly): `alt_domains` (old/redirecting domains kept as aliases; lookups match them) and `last_researched_at` (stamped when `deep_research` is written or `mark_researched: true`).
| `firm_domain` (people, write-time) | `accel.com` | domain of their current firm — creates the person→firm affiliation |

## `tier` — A, B, or C

Grade based on how popular, reputable, helpful, strong-networked, and founder-friendly the investor is:

- **A** — top-tier: widely known brand, strong track record/exits, dense network, founders actively seek them
- **B** — solid: established, credible portfolio, good reputation, less brand pull than A
- **C** — emerging or niche: newer funds, small angels, limited track record or network

When in doubt between two tiers, pick the lower one.
