# Sales CRM — setup & runbook

The studio's sales standup CRM (built from `crm-master-prompt.md`). Everything is prefixed `crm_` / `crm-` / `/crm` so it stays separable from the investor product and the outreach platform.

## What exists

| Piece | Where |
|---|---|
| SQL (schema, rules, RPCs, seed) | `migrations/crm/001_schema.sql`, `002_functions.sql`, `003_seed.sql` |
| MCP connector (edge function) | `supabase/functions/crm-mcp/` → `https://ktwqkvjuzsunssudqnrt.supabase.co/functions/v1/crm-mcp/mcp` |
| Claude skill | `claude-skill/crm/` (+ `crm.zip`) |
| Web app | `app/crm/**`, `components/crm/**`, `lib/crm/**`, `contexts/CrmContext.tsx`; nav entry "Sales CRM" in `MainLayout` |
| Deploy script | `scripts/crm-deploy-functions.sh` |

## Access

Membership is the `crm_members` table; every active member sees and edits everything (RLS). Add people in **CRM → Settings → Team** (email of an existing CapitalxAI account) or with the connector tool `add_team_member`. Non-members see a "not on the team" screen and, in the connector, only `crm_whoami`.

## Rules enforced in the database (not just the UI)

1. A meeting becomes `held`/`no_show` only through `crm_capture_meeting` — a status update without a complete `crm_meeting_captures` row fails (`E_CAPTURE_REQUIRED`); an incomplete capture fails naming the missing fields (`E_CAPTURE_INCOMPLETE`).
2. Active deals without next step/date are surfaced as **stuck** (not blocked).
3. No activity for `stale_after_days` (default 14) → **stale** (computed in `crm_deals_v`).
4. Stage moves forward or to `lost`; backwards needs a reason (`E_STAGE_BACKWARD`). Every change writes `crm_stage_history` via trigger.
5. Values always carry a currency; unknown currency fails (`E_UNKNOWN_CURRENCY`). `crm_fx_rates` drives USD totals.

Verified with a rollback test block (T1–T12) on 2026-09-16; re-run it from the session notes if the triggers change.

## Applying SQL

```bash
# Management API (records nothing in supabase_migrations; idempotent files)
bash scripts/outreach-sql.sh migrations/crm/001_schema.sql
bash scripts/outreach-sql.sh migrations/crm/002_functions.sql
bash scripts/outreach-sql.sh migrations/crm/003_seed.sql      # seeds lookups/FX/team always, sample deals only on an empty CRM
```
Or paste each file into the Supabase MCP `apply_migration`. The seed's sample data is relative to "now" (3 meetings today, one uncaptured yesterday) — delete the `crm_companies` rows to remove it.

## Deploying the connector

```bash
CAPITALXAI_SUPABASE_ACCESS_TOKEN=sbp_... bash scripts/crm-deploy-functions.sh
# Docker not running? → OUTREACH_DEPLOY_EXTRA_ARGS="--use-api" bash scripts/crm-deploy-functions.sh
cd supabase/functions && deno check --node-modules-dir=none crm-mcp/index.ts   # type-check first
```
Connect in Claude (claude.ai connectors / Claude Desktop / Claude Code) with the URL above; OAuth goes through the project's Supabase Auth (consent page at `app.capitalxai.com/oauth/consent`). Upload `claude-skill/crm.zip` as the skill.

## Hooks left for later (schema-ready, not built)

- `crm_deals.delivery_project_id` — join to the client portal.
- `crm_activities.external_ref` (unique) + `log_activity` upsert — machine-written LinkedIn/email activity from the outreach platform.
- `crm_company_brief` — clean JSON for a proposal/deck generator.
