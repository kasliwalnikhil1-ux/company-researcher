#!/usr/bin/env bash
# Push the Oracle Object Storage (S3-compatible) credentials from oracle-storage.env to the crm-mcp edge function,
# as CRM_S3_* secrets. The CRM stores call audio there; the keys exist nowhere else (never in the browser, never in
# the skill) — clients only ever receive short-lived presigned URLs.
#
# Usage:
#   CAPITALXAI_SUPABASE_ACCESS_TOKEN=sbp_... bash scripts/crm-set-storage-secrets.sh [path/to/oracle-storage.env]
#
# Names are CRM_-prefixed because edge-function secrets are project-wide and other functions use their own S3_* / AWS_*.
# No redeploy needed: functions read secrets at start-up of each new instance (allow a minute).
set -euo pipefail
cd "$(dirname "$0")/.."

ENV_FILE="${1:-oracle-storage.env}"
PROJECT_REF="${OUTREACH_PROJECT_REF:-ktwqkvjuzsunssudqnrt}"
[ -f "$ENV_FILE" ] || { echo "ERROR: $ENV_FILE not found." >&2; exit 1; }
[ -n "${CAPITALXAI_SUPABASE_ACCESS_TOKEN:-}" ] || { echo "ERROR: CAPITALXAI_SUPABASE_ACCESS_TOKEN is not set." >&2; exit 1; }
command -v supabase >/dev/null 2>&1 || { echo "ERROR: supabase CLI not found on PATH." >&2; exit 1; }

get() { grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2- | tr -d '\r' | sed -e 's/^["'"'"']//' -e 's/["'"'"']$//'; }
ENDPOINT="$(get S3_ENDPOINT)"; REGION="$(get S3_REGION)"; BUCKET="$(get S3_BUCKET)"; KEY_ID="$(get AWS_ACCESS_KEY_ID)"; SECRET="$(get AWS_SECRET_ACCESS_KEY)"

for pair in "S3_ENDPOINT:$ENDPOINT" "S3_REGION:$REGION" "S3_BUCKET:$BUCKET" "AWS_ACCESS_KEY_ID:$KEY_ID" "AWS_SECRET_ACCESS_KEY:$SECRET"; do
  [ -n "${pair#*:}" ] || { echo "ERROR: ${pair%%:*} is empty in $ENV_FILE." >&2; exit 1; }
done
# An Oracle customer secret key is a 40-character access key + a 44-character secret. Anything else is a placeholder.
if [ ${#KEY_ID} -ne 40 ] || [ ${#SECRET} -ne 44 ]; then
  echo "ERROR: the keys in $ENV_FILE do not look like an Oracle customer secret key (access key ${#KEY_ID} chars, expected 40; secret ${#SECRET} chars, expected 44)." >&2
  echo "       Paste the real pair from Oracle Cloud → Profile → My profile → Tokens and keys → Customer secret keys (kaptured-s3)." >&2
  echo "       The secret is shown only once; if it is lost, delete the key and generate a new one." >&2
  exit 1
fi

export SUPABASE_ACCESS_TOKEN="$CAPITALXAI_SUPABASE_ACCESS_TOKEN"
supabase secrets set --project-ref "$PROJECT_REF" \
  "CRM_S3_ENDPOINT=$ENDPOINT" "CRM_S3_REGION=$REGION" "CRM_S3_BUCKET=$BUCKET" "CRM_S3_ACCESS_KEY_ID=$KEY_ID" "CRM_S3_SECRET_ACCESS_KEY=$SECRET" >/dev/null
echo "ok: CRM_S3_* set on project $PROJECT_REF (bucket $BUCKET, region $REGION). Recording uploads work within about a minute."
