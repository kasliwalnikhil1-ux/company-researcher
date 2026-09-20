#!/usr/bin/env bash
# Template renderer checks (plan item 16). Run from anywhere: bash scripts/outreach-render-test.sh
#   1. the Deno copy passes the shared cases (lib/outreach/render.cases.json)
#   2. the web copy passes the same cases (tsx when it is installed, otherwise Deno runs the lib file)
#   3. the two render.ts files are identical once the leading // header comment is removed
set -euo pipefail
cd "$(dirname "$0")/.."

WEB=lib/outreach/render.ts
EDGE=supabase/functions/_shared/outreach/render.ts

echo "== 1/3 Deno copy"
deno test --quiet --allow-read --node-modules-dir=none supabase/functions/_shared/outreach/render_test.ts

echo "== 2/3 web copy"
if npx --no-install tsx --version >/dev/null 2>&1; then
  npx --no-install tsx lib/outreach/render.test.ts
else
  deno run --quiet --allow-read --allow-env --node-modules-dir=none --unstable-sloppy-imports lib/outreach/render.test.ts
fi

echo "== 3/3 the two copies are identical below the header"
strip_header() { awk 'body || !/^\/\//{ body = 1; print }' "$1" | tr -d '\r'; }
if ! diff <(strip_header "$WEB") <(strip_header "$EDGE") >/dev/null; then
  echo "FAIL: $WEB and $EDGE differ below the header comment:" >&2
  diff <(strip_header "$WEB") <(strip_header "$EDGE") >&2 || true
  exit 1
fi
echo "ok: render.ts copies are identical"
