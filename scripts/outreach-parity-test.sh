#!/usr/bin/env bash
# Outreach "one source of numbers" parity test (product plan item 2).
#
# Signs in as the outreach test user (.env.local: OUTREACH_TEST_EMAIL / OUTREACH_TEST_PASSWORD), then compares,
# for the same 7 days, every numeric key of:
#   outreach_dashboard().last_7_days  ==  outreach_report_overview().totals  ==  the connector's
#   report_overview / dashboard tools (JSON-RPC tools/call on /functions/v1/outreach-mcp/mcp, same JWT).
# Prints the keys that differ and exits 1 on any difference (2 = configuration problem).
#
#   ./scripts/outreach-parity-test.sh                       # all checks
#   ./scripts/outreach-parity-test.sh --rpc-only            # database only, no connector call
#   ./scripts/outreach-parity-test.sh --workspace <id|slug>
#
# The connector checks pass only after the connector is deployed: ./scripts/outreach-deploy-functions.sh mcp
set -euo pipefail
cd "$(dirname "$0")/.."
exec deno run --allow-net --allow-read --allow-env scripts/outreach-parity-test.ts "$@"
