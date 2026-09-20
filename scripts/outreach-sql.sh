#!/usr/bin/env bash
# Run a SQL file against the CapitalxAI Supabase project via the Management API and print the JSON result.
# Usage: CAPITALXAI_SUPABASE_ACCESS_TOKEN=sbp_... ./scripts/outreach-sql.sh path/to/file.sql
set -euo pipefail
PROJECT_REF="${OUTREACH_PROJECT_REF:-ktwqkvjuzsunssudqnrt}"
TOKEN="${CAPITALXAI_SUPABASE_ACCESS_TOKEN:?set CAPITALXAI_SUPABASE_ACCESS_TOKEN}"
FILE="${1:?sql file}"
Q="$(mktemp)"; trap 'rm -f "$Q"' EXIT   # per-run temp file: several people run this at once
python - "$FILE" > "$Q" <<'PY'
import json,sys
print(json.dumps({"query": open(sys.argv[1], encoding='utf-8').read()}))
PY
curl -s -X POST "https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query" \
  -H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" --data @"$Q" \
  | python -c "import sys,json; d=json.load(sys.stdin); print(d.get('message', json.dumps(d, indent=1)) if isinstance(d, dict) else json.dumps(d, indent=1))"
