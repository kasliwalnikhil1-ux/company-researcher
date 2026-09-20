#!/usr/bin/env bash
# Push the edge-function secrets (outreach / smartlead / crm) from the single app env file to the CapitalxAI
# Supabase project using the Management API (POST /v1/projects/{ref}/secrets with a JSON array of {name,value}).
#
# Usage:
#   cp .env.example .env.local && edit it (section 2 holds the edge-function secrets)
#   CAPITALXAI_SUPABASE_ACCESS_TOKEN=sbp_... ./scripts/outreach-set-secrets.sh [path/to/env-file] [--dry-run]
#
# Behaviour:
#   * lines are KEY=VALUE (optional `export ` prefix, optional single/double quotes around VALUE); # comments and
#     blank lines are ignored.
#   * ONLY allowlisted keys are pushed (UNIPILE_*, OUTREACH_* except OUTREACH_TEST_*, STRIPE_*, SMARTLEAD_*, CRM_*,
#     HUBSPOT_*, PIPEDRIVE_*, SALESFORCE_*, RESEND_API_KEY, GEMINI_API_KEY, GEMINI_MODEL_ID, EMAIL_FROM,
#     TEMP_MAX_AGE_HOURS). Everything else in the file (Next.js keys, test logins, ...) stays local.
#   * keys with an empty value are SKIPPED (existing secrets keep their value; nothing is deleted).
#   * keys starting with SUPABASE_ are skipped — those are reserved and injected by the platform.
#   * --dry-run prints the key names that would be pushed and exits without calling the API.
#   * values are never printed.
#
# Optional secrets (a feature stays off, without errors, while its secret is missing):
#   RESEND_API_KEY            transactional email: reconnect / paused notices, invitations, stall + running-dry + failed-import
#                             alerts, the weekly sender report, digests and client reports. Unset = emails are skipped and logged.
#   OUTREACH_EMAIL_FROM       platform From header, e.g. "CapitalxAI Outreach <no-reply@capitalxai.com>". The domain must be
#                             verified in Resend. White-label workspaces send from branding.email_from_address when THAT domain is
#                             verified in Resend too; otherwise the platform address is used with the agency's name and Reply-To.
#   HUBSPOT_CLIENT_ID / HUBSPOT_CLIENT_SECRET           CRM sync (item 22): OAuth app credentials, one pair per CRM you offer.
#   PIPEDRIVE_CLIENT_ID / PIPEDRIVE_CLIENT_SECRET       Redirect URL of each app: <functions base>/outreach-crm-oauth/callback
#   SALESFORCE_CLIENT_ID / SALESFORCE_CLIENT_SECRET     A CRM whose pair is missing shows as "not available" in Settings → Integrations.
#   STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_*   billing; without them usage is recorded but nothing is suspended or charged.
#
# Secrets take effect on the next invocation of each function (no redeploy needed).
# Optional env: OUTREACH_PROJECT_REF (default ktwqkvjuzsunssudqnrt)
set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT_REF="${OUTREACH_PROJECT_REF:-ktwqkvjuzsunssudqnrt}"
if [ -z "${CAPITALXAI_SUPABASE_ACCESS_TOKEN:-}" ]; then
  echo "ERROR: CAPITALXAI_SUPABASE_ACCESS_TOKEN is not set (Supabase personal access token, sbp_..., with access to ${PROJECT_REF})." >&2
  exit 1
fi
TOKEN="$CAPITALXAI_SUPABASE_ACCESS_TOKEN"

FILE=".env.local"
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help) sed -n '2,31p' "$0"; exit 0 ;;
    *) FILE="$arg" ;;
  esac
done
if [ ! -f "$FILE" ]; then
  echo "ERROR: ${FILE} not found. Copy .env.example to .env.local and fill it in." >&2
  exit 1
fi

PY=python
command -v python >/dev/null 2>&1 || PY=python3
command -v "$PY" >/dev/null 2>&1 || { echo "ERROR: python is required to build the JSON payload." >&2; exit 1; }

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

# Build the JSON array; print the names (only) to stderr.
"$PY" - "$FILE" > "$TMP" <<'PY'
import json, re, sys
path = sys.argv[1]
ALLOW = re.compile(r'^(UNIPILE_|OUTREACH_|STRIPE_|SMARTLEAD_|CRM_|HUBSPOT_|PIPEDRIVE_|SALESFORCE_)|^(RESEND_API_KEY|GEMINI_API_KEY|GEMINI_MODEL_ID|EMAIL_FROM|TEMP_MAX_AGE_HOURS)$')
out, skipped_empty, skipped_reserved, bad = [], [], [], []
for ln, raw in enumerate(open(path, encoding="utf-8"), 1):
    line = raw.strip()
    if not line or line.startswith("#"):
        continue
    if line.startswith("export "):
        line = line[7:].strip()
    m = re.match(r'^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$', line)
    if not m:
        bad.append(ln); continue
    key, val = m.group(1), m.group(2).strip()
    if len(val) >= 2 and val[0] == val[-1] and val[0] in "\"'":
        val = val[1:-1]
    elif " #" in val:  # trailing comment on an unquoted value
        val = val.split(" #", 1)[0].rstrip()
    if key.startswith("SUPABASE_"):
        skipped_reserved.append(key); continue
    if not ALLOW.match(key) or key.startswith("OUTREACH_TEST_"):
        continue  # app-only / local-only key: never leaves this machine
    if val == "":
        skipped_empty.append(key); continue
    out.append({"name": key, "value": val})
print(json.dumps(out))
sys.stderr.write("will set (%d): %s\n" % (len(out), ", ".join(s["name"] for s in out) or "-"))
if skipped_empty:
    sys.stderr.write("skipped (empty): %s\n" % ", ".join(skipped_empty))
if skipped_reserved:
    sys.stderr.write("skipped (reserved SUPABASE_*): %s\n" % ", ".join(skipped_reserved))
if bad:
    sys.stderr.write("WARN: unparsable line(s): %s\n" % ", ".join(map(str, bad)))
if not out:
    sys.stderr.write("nothing to set\n")
    sys.exit(2)
PY

if [ "$DRY_RUN" -eq 1 ]; then
  echo "(dry run) not calling the API."
  exit 0
fi

echo "pushing secrets to project ${PROJECT_REF} ..."
out=$(curl -s -w '\n%{http_code}' -X POST "https://api.supabase.com/v1/projects/${PROJECT_REF}/secrets" \
  -H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" --data @"$TMP")
code=$(echo "$out" | tail -n1)
body=$(echo "$out" | sed '$d')
if [ "$code" != "200" ] && [ "$code" != "201" ]; then
  echo "FAILED (${code}): ${body}" >&2
  exit 1
fi
echo "ok (${code})"

# Show what the project now has (names only)
names=$(curl -s "https://api.supabase.com/v1/projects/${PROJECT_REF}/secrets" -H "Authorization: Bearer ${TOKEN}" \
  | "$PY" -c 'import sys,json
try:
    d=json.load(sys.stdin); print(", ".join(sorted(x["name"] for x in d if not x["name"].startswith("SUPABASE_"))))
except Exception as e:
    print("(could not list secrets: %s)" % e)')
echo "secrets now defined: ${names}"
echo
echo "Reminder: OUTREACH_CRON_SECRET must equal the value stored in Vault by scripts/outreach-apply-migrations.sh"
echo "          (vault secret name: outreach_cron_secret). Re-run 004_seed_cron.sql if you rotated it."
