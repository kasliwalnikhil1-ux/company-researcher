#!/usr/bin/env bash
# Deploy the outreach platform edge functions (supabase/functions/outreach-*) to the CapitalxAI Supabase project.
#
# Usage:
#   CAPITALXAI_SUPABASE_ACCESS_TOKEN=sbp_... ./scripts/outreach-deploy-functions.sh            # all 39 functions
#   CAPITALXAI_SUPABASE_ACCESS_TOKEN=sbp_... ./scripts/outreach-deploy-functions.sh worker-tick outreach-process-inbound
#
# Names may be given with or without the `outreach-` prefix. Deploys one function at a time, continues on
# error, and prints a summary at the end (exit code 1 if anything failed).
#
# Optional env:
#   OUTREACH_PROJECT_REF        project ref (default ktwqkvjuzsunssudqnrt)
#   OUTREACH_DEPLOY_EXTRA_ARGS  extra flags appended to every `supabase functions deploy` (e.g. "--use-api" to
#                               bundle via the API instead of Docker on older CLI versions, or "--debug")
#
# Why every function is deployed with --no-verify-jwt:
#   * webhooks / extension / cron workers verify their own secret or token in code
#     (unipile-auth header, Bearer <sender_token>, x-cron-secret, Stripe signature);
#     the platform JWT gate would reject those callers outright.
#   * user-facing functions validate the user JWT themselves via `requireUser()` in
#     supabase/functions/_shared/outreach/supabase.ts (auth.getUser(token) → RLS-scoped client). The platform
#     gate (`verify_jwt: true`) runs *before* the function code and also rejects the browser's CORS preflight
#     (OPTIONS carries no Authorization header), so the web app could never call them cross-origin. Turning the
#     gate off and checking in code keeps preflight working without weakening auth.
#
# Note: the Supabase CLI account that is logged in locally may not have access to this project (403). Passing the
# project token via SUPABASE_ACCESS_TOKEN (done below from CAPITALXAI_SUPABASE_ACCESS_TOKEN) overrides the CLI login.
set -uo pipefail
cd "$(dirname "$0")/.."

PROJECT_REF="${OUTREACH_PROJECT_REF:-ktwqkvjuzsunssudqnrt}"
if [ -z "${CAPITALXAI_SUPABASE_ACCESS_TOKEN:-}" ]; then
  echo "ERROR: CAPITALXAI_SUPABASE_ACCESS_TOKEN is not set." >&2
  echo "       Export the Supabase personal access token (sbp_...) that has access to project ${PROJECT_REF}." >&2
  echo "       Example: CAPITALXAI_SUPABASE_ACCESS_TOKEN=sbp_xxx $0" >&2
  exit 1
fi
export SUPABASE_ACCESS_TOKEN="$CAPITALXAI_SUPABASE_ACCESS_TOKEN"

if ! command -v supabase >/dev/null 2>&1; then
  echo "ERROR: supabase CLI not found on PATH (https://supabase.com/docs/guides/cli)." >&2
  exit 1
fi

# --- function catalogue ------------------------------------------------------------------------------------------
# Verify their own secret/token (must be --no-verify-jwt):
WEBHOOK_FUNCS=(
  outreach-unipile-webhook   # header unipile-auth == UNIPILE_WEBHOOK_SECRET
  outreach-sender-notify     # Unipile hosted-auth notify_url callback (sender id in `name`)
  outreach-cookie-sync       # Bearer <sender_token> from the Chrome extension
  outreach-stripe-webhook    # Stripe signature (also user JWT for checkout/portal)
  outreach-booking-webhook   # Calendly / Cal.com: ?ws=<workspace>&k=<booking_secret> checked in code (constant time)
  outreach-unsubscribe       # public one-click unsubscribe: signed token (HMAC, OUTREACH_CRON_SECRET) checked in code
  outreach-crm-oauth         # OAuth callback is public (state checked in code); the start call validates the user JWT
)
# Cron workers (x-cron-secret via outreach_invoke / pg_net):
CRON_FUNCS=(
  outreach-process-inbound
  outreach-worker-tick
  outreach-worker-planner
  outreach-worker-health
  outreach-worker-reconnect
  outreach-worker-imports
  outreach-worker-withdraw
  outreach-worker-relations-poll
  outreach-outbound-webhooks
  outreach-billing-sync
  outreach-ai-classify
  outreach-ai-draft          # cron ({} fills pending drafts) AND user JWT
  outreach-worker-enrich     # background profile enrichment (every 10 min)
  outreach-ai-variables      # AI lines + AI routing decisions (every minute) AND user JWT ("test on 20 leads")
  outreach-crm-sync          # CRM push / pull (every 5 min)
  outreach-worker-reports    # weekly sender report, digests, client reports (hourly; sends at 08:00 workspace time)
  outreach-domain-check      # DNS checks for portal + tracking domains (every 30 min)
  outreach-worker-profile    # Profile Studio: verify applied changes, owner emails, experiments (every 5 min); weekly drift + QA
  outreach-worker-channels   # Instagram / WhatsApp: followers poll (35 * * * *), identifier check (*/30), block detect (55 * * * *), transcribe (* * * * *), wa_governor
)
# User-JWT functions (validate the JWT in code via requireUser; --no-verify-jwt so CORS preflight works):
USER_FUNCS=(
  outreach-sender-connect
  outreach-sender-update-proxy
  outreach-sender-disable
  outreach-sender-manage
  outreach-send-reply
  outreach-edit-message
  outreach-attachment-proxy
  outreach-ai-sequence-qa
  outreach-imports-create
  outreach-exports-create
  outreach-invite-member
  outreach-unipile-setup
  outreach-mcp               # remote MCP connector (OAuth bearer checked in code; .well-known must be public)
  outreach-workspace-secrets # stores the workspace's own AI / finder keys (encrypted); owner JWT
  outreach-api               # public REST API: the API key is checked in code (outreach_api_authenticate)
  outreach-profile           # Profile Studio: user actions (JWT) + the owner's public token pages (authority / approve / revert)
)
ALL_FUNCS=("${WEBHOOK_FUNCS[@]}" "${CRON_FUNCS[@]}" "${USER_FUNCS[@]}")

# --- resolve targets ---------------------------------------------------------------------------------------------
TARGETS=()
if [ $# -gt 0 ]; then
  for arg in "$@"; do
    name="$arg"
    case "$name" in outreach-*) ;; *) name="outreach-$name" ;; esac
    TARGETS+=("$name")
  done
else
  # "all": functions of other workstreams may not be in this checkout yet; skip those instead of aborting the whole deploy
  for name in "${ALL_FUNCS[@]}"; do
    if [ -f "supabase/functions/${name}/index.ts" ]; then TARGETS+=("$name"); else echo "WARN: ${name} is in the catalogue but supabase/functions/${name}/index.ts does not exist yet (skipped)." >&2; fi
  done
fi

# sanity: every target must exist on disk; warn if it is not in the catalogue above
for name in "${TARGETS[@]}"; do
  if [ ! -f "supabase/functions/${name}/index.ts" ]; then
    echo "ERROR: supabase/functions/${name}/index.ts not found." >&2
    exit 1
  fi
  known=0
  for k in "${ALL_FUNCS[@]}"; do [ "$k" = "$name" ] && known=1 && break; done
  [ $known -eq 1 ] || echo "WARN: ${name} is not in the catalogue in this script (deploying anyway with --no-verify-jwt)."
done

# --- deploy --------------------------------------------------------------------------------------------------------
EXTRA_ARGS=()
if [ -n "${OUTREACH_DEPLOY_EXTRA_ARGS:-}" ]; then
  # shellcheck disable=SC2206
  EXTRA_ARGS=(${OUTREACH_DEPLOY_EXTRA_ARGS})
fi

OK=()
FAILED=()
START=$(date +%s)
echo "Deploying ${#TARGETS[@]} function(s) to project ${PROJECT_REF} (--no-verify-jwt)"
echo

for name in "${TARGETS[@]}"; do
  echo "== ${name}"
  if supabase functions deploy "$name" --project-ref "$PROJECT_REF" --no-verify-jwt ${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}; then
    OK+=("$name")
    echo "   ok"
  else
    FAILED+=("$name")
    echo "   FAILED (continuing)" >&2
  fi
  echo
done

# --- summary -------------------------------------------------------------------------------------------------------
ELAPSED=$(( $(date +%s) - START ))
echo "================ summary ================"
echo "project:   ${PROJECT_REF}"
echo "base URL:  https://${PROJECT_REF}.supabase.co/functions/v1/"
echo "deployed:  ${#OK[@]}"
for n in ${OK[@]+"${OK[@]}"};         do echo "   + $n"; done
echo "failed:    ${#FAILED[@]}"
for n in ${FAILED[@]+"${FAILED[@]}"}; do echo "   - $n"; done
echo "elapsed:   ${ELAPSED}s"
if [ ${#FAILED[@]} -gt 0 ]; then
  echo
  echo "Re-run only the failed ones with:"
  echo "   $0 ${FAILED[*]}"
  exit 1
fi
echo
echo "Next: make sure secrets are set (scripts/outreach-set-secrets.sh) and register Unipile webhooks"
echo "      (Settings → Workspace → Platform setup, or POST outreach-unipile-setup {action:'register'})."
