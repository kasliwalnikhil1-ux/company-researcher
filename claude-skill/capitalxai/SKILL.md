---
name: capitalxai
description: Browse the CapitalxAI investor database via its MCP connector. Use when the user wants to look up investor firms/people or explore recent funding rounds, and the CapitalxAI connector tools (find_investors, list_fundings, get_funding) are available.
---

# CapitalxAI

CapitalxAI is a fundraising intelligence app with a shared database of investors (firms and people) and recent funding rounds. This skill explains how to use its MCP connector tools well. All tools require the user to have connected the "CapitalxAI" connector (they log in with their CapitalxAI account and approve access).

## Tools at a glance

| Tool | What it does |
|---|---|
| `find_investors` | Search investors by name, firm domain, or LinkedIn URL |
| `list_fundings` | Recent funding rounds, newest first, with search and paging |
| `get_funding` | Full record of one funding (complete founders/investors lists) |

## Data conventions

- Firms are identified by `domain` (bare, lowercase, no www — `accel.com`), people by their LinkedIn URL. Full URLs are accepted; the server strips protocol/`www.` automatically.
- Funding amounts are USD numbers: `5000000` means $5M. Present them readably ("$5M", "$12.5M").
- Show dates in readable form ("June 15, 2026"), never as raw ISO stamps like 2026-06-15.
- Linked-name lists (`founders`, `investors`) come back as `{name, url}` pairs — the url is the firm domain for organizations and the LinkedIn URL for individuals. Show them as plain links.

## Workflows

### Looking up an investor
1. `find_investors` with whichever identifier the user gave: a name (`query`), a firm domain, or a LinkedIn URL. Use `type` to narrow to only firms or only people when the user is specific.
2. Results include tier, investor type, role, and country when known. If nothing matches, say so — don't guess or fabricate investor details.

### Exploring fundings
1. `list_fundings` for a feed of recently funded companies; use `search` to filter by company name or domain.
2. Page with `offset` when the user wants more (the reply says how many exist in total).
3. For one company's full picture — all founders, all investors, USP, founding year — call `get_funding` with its domain or id.

## Conventions

- Never fabricate investor data (fund sizes, theses, portfolio companies). Report only what the tools return, and cite the company/investor names as they appear in the database.
- If a tool returns an authorization error, the connector needs to be reconnected: tell the user to re-connect CapitalxAI in their Claude connector settings.
