#!/usr/bin/env bash
# Run the Playwright suites against the isolated Docker stack. The exit code is the runner's.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
export TESTFORGE_RUN_ID="${TESTFORGE_RUN_ID:-docker-$(date +%Y%m%d-%H%M%S)}"
compose() { docker compose -f compose.test.yaml "$@"; }
compose up --build --abort-on-container-exit --exit-code-from runner
status=$?
mkdir -p reports/runs
if ! compose cp runner:/app/reports/runs/. reports/runs/; then
  echo "No reports could be copied from the runner" >&2
  [[ "$status" -eq 0 ]] && status=1
fi
compose down -v --remove-orphans
echo "Reports: reports/runs/$TESTFORGE_RUN_ID"
exit "$status"
