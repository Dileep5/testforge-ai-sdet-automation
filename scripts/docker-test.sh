#!/usr/bin/env bash
# Run the Playwright suites against the isolated Docker stack. The exit code is the runner's.
#
# The stack is started first and the runner separately, because --abort-on-container-exit stops
# everything as soon as any container exits, including the one-shot migrate step when it succeeds.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
export TESTFORGE_RUN_ID="${TESTFORGE_RUN_ID:-docker-$(date +%Y%m%d-%H%M%S)}"
RUNNER="testforge-test-runner-$TESTFORGE_RUN_ID"
compose() { docker compose -f compose.test.yaml "$@"; }
finish() {
  docker rm --force "$RUNNER" >/dev/null 2>&1
  compose down -v --remove-orphans
}
trap finish EXIT

if ! compose build; then
  echo "The images did not build" >&2
  exit 1
fi
if ! compose up --detach --wait web; then
  echo "The stack did not become healthy. Container logs:" >&2
  compose logs --no-color migrate api web >&2
  exit 1
fi

compose run --no-deps --no-TTY --name "$RUNNER" runner
status=$?
if [[ "$status" -ne 0 ]]; then
  echo "Container logs, for the failed run:" >&2
  compose logs --no-color api web >&2
fi

mkdir -p reports/runs
if ! docker cp "$RUNNER:/app/reports/runs/." reports/runs/; then
  echo "No reports could be copied from the runner" >&2
  [[ "$status" -eq 0 ]] && status=1
fi
echo "Reports: reports/runs/$TESTFORGE_RUN_ID"
exit "$status"
