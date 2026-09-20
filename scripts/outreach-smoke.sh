#!/usr/bin/env bash
# Run every SQL smoke test in migrations/outreach/tests against the project and fail unless each one ends in "SMOKE OK".
# Each test builds its own fixtures and RAISES at the end, so nothing it writes survives (the raise is how the log gets out:
# the Management API returns no NOTICEs).
#
# Usage: CAPITALXAI_SUPABASE_ACCESS_TOKEN=sbp_... ./scripts/outreach-smoke.sh [test-file ...]
set -uo pipefail
cd "$(dirname "$0")/.."
FILES=("$@")
if [ ${#FILES[@]} -eq 0 ]; then FILES=(migrations/outreach/tests/smoke_*.sql); fi
fail=0
for f in "${FILES[@]}"; do
  out=$(bash scripts/outreach-sql.sh "$f" 2>&1)
  if echo "$out" | grep -q "SMOKE OK"; then
    echo "PASS  $f  ($(echo "$out" | grep -c '^ok ') assertions)"
  else
    fail=1
    echo "FAIL  $f"
    echo "$out" | grep -v '^ok ' | head -40
  fi
done
exit $fail
