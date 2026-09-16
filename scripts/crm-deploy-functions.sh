#!/usr/bin/env bash
# Deploy the Sales CRM edge function(s) (supabase/functions/crm-*) to the CapitalxAI Supabase project.
#
# Usage:
#   CAPITALXAI_SUPABASE_ACCESS_TOKEN=sbp_... ./scripts/crm-deploy-functions.sh          # crm-mcp
#
# Optional env (same as the outreach script):
#   OUTREACH_PROJECT_REF        project ref (default ktwqkvjuzsunssudqnrt)
#   OUTREACH_DEPLOY_EXTRA_ARGS  extra flags for `supabase functions deploy` (e.g. "--use-api" when Docker is not running)
#
# --no-verify-jwt on purpose: the MCP .well-known document and the 401 challenge must be reachable
# without a token; bearer auth is enforced in-function for /mcp (see crm-mcp/index.ts).
#
# SQL for the CRM lives in migrations/crm/*.sql and is applied with:
#   bash scripts/outreach-sql.sh migrations/crm/001_schema.sql   (then 002_functions.sql, 003_seed.sql)
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
[ ${#TARGETS[@]} -eq 0 ] && TARGETS=(crm-mcp)

EXTRA_ARGS=()
if [ -n "${OUTREACH_DEPLOY_EXTRA_ARGS:-}" ]; then
  # shellcheck disable=SC2206
  EXTRA_ARGS=(${OUTREACH_DEPLOY_EXTRA_ARGS})
fi

FAILED=()
for name in "${TARGETS[@]}"; do
  case "$name" in crm-*) ;; *) name="crm-$name" ;; esac
  [ -f "supabase/functions/${name}/index.ts" ] || { echo "ERROR: supabase/functions/${name}/index.ts not found." >&2; exit 1; }
  echo "== ${name}"
  if supabase functions deploy "$name" --project-ref "$PROJECT_REF" --no-verify-jwt ${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}; then
    echo "   ok  → https://${PROJECT_REF}.supabase.co/functions/v1/${name}/mcp"
  else
    FAILED+=("$name"); echo "   FAILED" >&2
  fi
done
[ ${#FAILED[@]} -eq 0 ] || { echo "failed: ${FAILED[*]}" >&2; exit 1; }
