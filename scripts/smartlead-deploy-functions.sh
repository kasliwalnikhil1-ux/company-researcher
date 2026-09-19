#!/usr/bin/env bash
# Deploy the Smartlead MCP edge function (supabase/functions/smartlead-*) to the CapitalxAI Supabase project.
#
# Usage:
#   CAPITALXAI_SUPABASE_ACCESS_TOKEN=sbp_... ./scripts/smartlead-deploy-functions.sh    # smartlead-mcp
#
# Optional env (same as the outreach script):
#   OUTREACH_PROJECT_REF        project ref (default ktwqkvjuzsunssudqnrt)
#   OUTREACH_DEPLOY_EXTRA_ARGS  extra flags for `supabase functions deploy` (e.g. "--use-api" when Docker is not running)
#
# --no-verify-jwt on purpose: the MCP .well-known document and the 401 challenge must be reachable
# without a token; bearer auth is enforced in-function for /mcp (see smartlead-mcp/index.ts).
#
# SQL lives in migrations/smartlead/*.sql and is applied with (or via Supabase MCP apply_migration):
#   bash scripts/outreach-sql.sh migrations/smartlead/001_schema.sql
#
# The function needs the secret SMARTLEAD_API_KEY (Smartlead → Settings → API):
#   SUPABASE_ACCESS_TOKEN=$CAPITALXAI_SUPABASE_ACCESS_TOKEN supabase secrets set SMARTLEAD_API_KEY=... --project-ref ktwqkvjuzsunssudqnrt
set -uo pipefail
cd "$(dirname "$0")/.."

PROJECT_REF="${OUTREACH_PROJECT_REF:-ktwqkvjuzsunssudqnrt}"
if [ -z "${CAPITALXAI_SUPABASE_ACCESS_TOKEN:-}" ]; then
  echo "ERROR: CAPITALXAI_SUPABASE_ACCESS_TOKEN is not set (Supabase personal access token with access to ${PROJECT_REF})." >&2
  exit 1
fi
export SUPABASE_ACCESS_TOKEN="$CAPITALXAI_SUPABASE_ACCESS_TOKEN"
command -v supabase >/dev/null 2>&1 || { echo "ERROR: supabase CLI not found on PATH." >&2; exit 1; }

TARGETS=("$@")
[ ${#TARGETS[@]} -eq 0 ] && TARGETS=(smartlead-mcp)

EXTRA_ARGS=()
if [ -n "${OUTREACH_DEPLOY_EXTRA_ARGS:-}" ]; then
  # shellcheck disable=SC2206
  EXTRA_ARGS=(${OUTREACH_DEPLOY_EXTRA_ARGS})
fi

FAILED=()
for name in "${TARGETS[@]}"; do
  case "$name" in smartlead-*) ;; *) name="smartlead-$name" ;; esac
  [ -f "supabase/functions/${name}/index.ts" ] || { echo "ERROR: supabase/functions/${name}/index.ts not found." >&2; exit 1; }
  echo "== ${name}"
  if supabase functions deploy "$name" --project-ref "$PROJECT_REF" --no-verify-jwt ${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}; then
    echo "   ok  → https://${PROJECT_REF}.supabase.co/functions/v1/${name}/mcp"
  else
    FAILED+=("$name"); echo "   FAILED" >&2
  fi
done
[ ${#FAILED[@]} -eq 0 ] || { echo "failed: ${FAILED[*]}" >&2; exit 1; }
