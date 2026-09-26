#!/usr/bin/env bash
# Apply the outreach platform migrations to the CapitalxAI Supabase project via the Management API.
#
# Usage:
#   CAPITALXAI_SUPABASE_ACCESS_TOKEN=sbp_... OUTREACH_CRON_SECRET=<secret> ./scripts/outreach-apply-migrations.sh [files...]
#
# Defaults to applying 001..026 in order (every file is idempotent). Afterwards run ./scripts/outreach-smoke.sh. The cron secret must match the edge function secret OUTREACH_CRON_SECRET.
set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT_REF="${OUTREACH_PROJECT_REF:-ktwqkvjuzsunssudqnrt}"
TOKEN="${CAPITALXAI_SUPABASE_ACCESS_TOKEN:?set CAPITALXAI_SUPABASE_ACCESS_TOKEN}"
CRON_SECRET="${OUTREACH_CRON_SECRET:?set OUTREACH_CRON_SECRET}"
BASE_URL="https://${PROJECT_REF}.supabase.co/functions/v1/"

FILES=("$@")
if [ ${#FILES[@]} -eq 0 ]; then
  FILES=(migrations/outreach/001_schema.sql migrations/outreach/002_functions.sql migrations/outreach/003_triggers_rls.sql migrations/outreach/004_seed_cron.sql migrations/outreach/005_patches.sql migrations/outreach/006_rpc_hardening.sql migrations/outreach/007_intent_override.sql migrations/outreach/008_agent_mcp.sql
         # product plan (Sept 2026). 009 adds enum values and MUST be its own call: a new enum value cannot be used in the transaction that adds it.
         migrations/outreach/009_enums_v2.sql migrations/outreach/010_schema_v2.sql migrations/outreach/011_engine_v2.sql migrations/outreach/012_editing_recovery_enrol.sql
         migrations/outreach/013_reports.sql migrations/outreach/014_intelligence.sql migrations/outreach/015_platform.sql migrations/outreach/016_seed_cron_v2.sql migrations/outreach/017_hardening.sql
         # 018 closes internal helpers to signed-in users; it must follow 017, which re-grants whatever they could already execute.
         migrations/outreach/018_scope_hardening.sql
         migrations/outreach/019_browser_auth.sql migrations/outreach/020_condition_connect_path.sql
         # Profile Studio (Sept 2026). 021 adds enum values and MUST be its own call.
         migrations/outreach/021_profile_enums.sql migrations/outreach/022_profile_studio.sql migrations/outreach/023_profile_functions.sql
         # Instagram & WhatsApp channels (Sept 2026). 024 adds enum values and MUST be its own call; 025 re-keys ceilings / warm-up by provider.
         migrations/outreach/024_channel_enums.sql migrations/outreach/025_channels_schema.sql migrations/outreach/026_channels_functions.sql)
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
