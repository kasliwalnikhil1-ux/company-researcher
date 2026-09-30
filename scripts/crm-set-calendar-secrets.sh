#!/usr/bin/env bash
# Point the CRM's Google Calendar at a Google OAuth client and set the token-encryption key, as crm-mcp edge secrets:
#   CRM_GOOGLE_CLIENT_ID / CRM_GOOGLE_CLIENT_SECRET / CRM_GOOGLE_CLIENT_KIND (desktop|web) / CRM_TOKEN_KEY
#
# Default client = Desk's own (desk-by-kaptured-ai, type Desktop), so no Google console work is needed:
#   CAPITALXAI_SUPABASE_ACCESS_TOKEN=sbp_... bash scripts/crm-set-calendar-secrets.sh \
#       ../recorder-app/CallRecorder/resources/google_oauth_client.json
# A Desktop client only returns to loopback addresses: the app on localhost gets Google straight back; the hosted app and
# Claude/ChatGPT use a one-time paste-back of the address Google lands on. A "Web application" client JSON (redirect URI
# https://<ref>.supabase.co/functions/v1/crm-mcp/calendar/callback) makes every path automatic — pass that file instead.
#
# The values (and the generated CRM_TOKEN_KEY) are also written to google-calendar.env (git-ignored). Keep that file:
# members' refresh tokens are encrypted with CRM_TOKEN_KEY; losing it means everyone reconnects. Re-running the script
# reuses the key from that file. No redeploy needed: new function instances read secrets within about a minute.
set -euo pipefail
cd "$(dirname "$0")/.."

SRC="${1:-google-calendar.env}"
ENV_FILE="google-calendar.env"
PROJECT_REF="${OUTREACH_PROJECT_REF:-ktwqkvjuzsunssudqnrt}"
[ -f "$SRC" ] || { echo "ERROR: $SRC not found. Pass Desk's resources/google_oauth_client.json (or a filled google-calendar.env)." >&2; exit 1; }
[ -n "${CAPITALXAI_SUPABASE_ACCESS_TOKEN:-}" ] || { echo "ERROR: CAPITALXAI_SUPABASE_ACCESS_TOKEN is not set." >&2; exit 1; }
command -v supabase >/dev/null 2>&1 || { echo "ERROR: supabase CLI not found on PATH." >&2; exit 1; }

getenv() { [ -f "$ENV_FILE" ] && grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2- | tr -d '\r' | sed -e 's/^["'"'"']//' -e 's/["'"'"']$//' || true; }

case "$SRC" in
  *.json)
    LINE="$(python - "$SRC" <<'PY'
import json, sys
d = json.load(open(sys.argv[1], encoding="utf-8"))
kind, v = ("web", d["web"]) if "web" in d else ("desktop", d.get("installed") or d)
print(kind, v["client_id"].strip(), v.get("client_secret", "").strip())
PY
)"
    LINE="${LINE//$'\r'/}"   # Windows Python prints CRLF; a stray \r would end up inside the secret
    read -r KIND CLIENT_ID CLIENT_SECRET <<< "$LINE"
    ;;
  *)
    ENV_FILE="$SRC"; CLIENT_ID="$(getenv GOOGLE_CLIENT_ID)"; CLIENT_SECRET="$(getenv GOOGLE_CLIENT_SECRET)"; KIND="$(getenv GOOGLE_CLIENT_KIND)"; KIND="${KIND:-desktop}"
    ;;
esac
TOKEN_KEY="$(getenv CRM_TOKEN_KEY)"

case "$CLIENT_ID" in *.apps.googleusercontent.com) ;; *) echo "ERROR: client_id should end in .apps.googleusercontent.com." >&2; exit 1 ;; esac
[ ${#CLIENT_SECRET} -ge 20 ] || { echo "ERROR: client_secret looks empty or too short." >&2; exit 1; }
case "$KIND" in desktop|web) ;; *) echo "ERROR: client kind must be desktop or web (got $KIND)." >&2; exit 1 ;; esac
[ -n "$TOKEN_KEY" ] || TOKEN_KEY="$(python -c 'import secrets; print(secrets.token_urlsafe(48))')"
[ ${#TOKEN_KEY} -ge 32 ] || { echo "ERROR: CRM_TOKEN_KEY must be at least 32 characters." >&2; exit 1; }

# keep a private copy so the key survives (git-ignored)
umask 077
cat > "$ENV_FILE" <<EOF
# CRM Google Calendar — pushed to crm-mcp by scripts/crm-set-calendar-secrets.sh. Git-ignored. Keep CRM_TOKEN_KEY safe.
GOOGLE_CLIENT_KIND=$KIND
GOOGLE_CLIENT_ID=$CLIENT_ID
GOOGLE_CLIENT_SECRET=$CLIENT_SECRET
CRM_TOKEN_KEY=$TOKEN_KEY
EOF

export SUPABASE_ACCESS_TOKEN="$CAPITALXAI_SUPABASE_ACCESS_TOKEN"
supabase secrets set --project-ref "$PROJECT_REF" \
  "CRM_GOOGLE_CLIENT_ID=$CLIENT_ID" "CRM_GOOGLE_CLIENT_SECRET=$CLIENT_SECRET" "CRM_GOOGLE_CLIENT_KIND=$KIND" "CRM_TOKEN_KEY=$TOKEN_KEY" >/dev/null
echo "ok: $KIND client ${CLIENT_ID%%-*}… set on project $PROJECT_REF (key saved in $ENV_FILE)."
if [ "$KIND" = "web" ]; then
  echo "    the client's redirect URI must be https://${PROJECT_REF}.supabase.co/functions/v1/crm-mcp/calendar/callback"
else
  echo "    localhost app: Google returns by itself. Hosted app / Claude / ChatGPT: paste back the 127.0.0.1:53682 address once per account."
fi
