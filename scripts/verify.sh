#!/usr/bin/env bash
# Full verification for the Hono taskboard fixture:
#
#   1. scripts/build.sh -> release marker (VERSION) + tsc compile to dist/
#   2. clean install -> rm -rf node_modules && npm ci (frozen lockfile)
#   3. tsc --noEmit typecheck (strict)
#   4. client JavaScript syntax check (node --check)
#   5. node --test dist/tests (unit/integration suite)
#   6. scripts/smoke.sh -> real production process: CRUD, invalid input,
#      search/filter, restart persistence, database-unavailable readiness
#
# Usage:
#   scripts/verify.sh
#
# Exit codes: 0 = all checks passed, nonzero = a check failed. The first
# failing step aborts with its own nonzero code.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE="${NODE:-$(command -v node)}"
NPM="${NPM:-$(command -v npm)}"
[ -x "$NODE" ] || { echo "node executable not found" >&2; exit 1; }
[ -x "$NPM" ] || { echo "npm executable not found" >&2; exit 1; }

step() { printf '\n=== %s ===\n' "$*"; }

step "build release marker + production build (tsc)"
"$ROOT/scripts/build.sh"

step "clean install with frozen lockfile"
rm -rf "$ROOT/node_modules"
(cd "$ROOT" && "$NPM" ci --no-audit --no-fund)

step "strict typecheck (tsc --noEmit)"
(cd "$ROOT" && npx tsc --noEmit -p tsconfig.json)

step "client JavaScript syntax check"
"$NODE" --check "$ROOT/public/app.js"

step "test suite (node --test dist/tests)"
(cd "$ROOT" && "$NODE" --test "dist/tests/*.test.js")

step "production smoke: real process + CRUD + negatives + persistence + readiness"
"$ROOT/scripts/smoke.sh"

step "verification complete (all steps passed)"
printf '%s\n' "node: $("$NODE" --version)"
printf '%s\n' "npm: $("$NPM" --version)"
printf '%s\n' "node_modules installed: $([ -d "$ROOT/node_modules" ] && echo yes || echo no)"
printf '%s\n' "release marker: $(cat "$ROOT/VERSION")"