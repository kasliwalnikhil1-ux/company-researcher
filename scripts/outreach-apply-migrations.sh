#!/usr/bin/env bash
# Apply the outreach platform migrations to the CapitalxAI Supabase project via the Management API.
#
# Usage:
#   CAPITALXAI_SUPABASE_ACCESS_TOKEN=sbp_... OUTREACH_CRON_SECRET=<secret> ./scripts/outreach-apply-migrations.sh [files...]
#
# Defaults to applying 001..004 in order. The cron secret must match the edge function secret OUTREACH_CRON_SECRET.
set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT_REF="${OUTREACH_PROJECT_REF:-ktwqkvjuzsunssudqnrt}"
TOKEN="${CAPITALXAI_SUPABASE_ACCESS_TOKEN:?set CAPITALXAI_SUPABASE_ACCESS_TOKEN}"
CRON_SECRET="${OUTREACH_CRON_SECRET:?set OUTREACH_CRON_SECRET}"
BASE_URL="https://${PROJECT_REF}.supabase.co/functions/v1/"

FILES=("$@")
if [ ${#FILES[@]} -eq 0 ]; then
  FILES=(migrations/outreach/001_schema.sql migrations/outreach/002_functions.sql migrations/outreach/003_triggers_rls.sql migrations/outreach/004_seed_cron.sql migrations/outreach/005_patches.sql migrations/outreach/006_rpc_hardening.sql migrations/outreach/007_intent_override.sql)
fi

for f in "${FILES[@]}"; do
  echo "== applying $f"
  python - "$f" "$BASE_URL" "$CRON_SECRET" <<'PY' > /tmp/outreach_q.json
import json,sys
p,base,secret=sys.argv[1:4]
sql=open(p,encoding='utf-8').read().replace('__FUNCTIONS_BASE_URL__',base).replace('__CRON_SECRET__',secret)
print(json.dumps({"query":sql}))
PY
  out=$(curl -s -w '\n%{http_code}' -X POST "https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query" \
    -H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" --data @/tmp/outreach_q.json)
  code=$(echo "$out" | tail -n1)
  body=$(echo "$out" | sed '$d')
  if [ "$code" != "200" ] && [ "$code" != "201" ]; then
    echo "FAILED ($code): $body"; exit 1
  fi
  echo "ok: $(echo "$body" | head -c 300)"
done
echo "done"
