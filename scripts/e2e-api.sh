#!/usr/bin/env bash
# Start the API for Playwright, against the dedicated E2E database. Started by playwright.config.ts.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

case "${DATABASE_URL:-}" in
  *_e2e) ;;
  *) echo "Refusing to start: DATABASE_URL must name a database ending in _e2e" >&2; exit 1 ;;
esac

bash "$ROOT/scripts/db-local.sh" start
cd "$ROOT/apps/api"
.venv/bin/alembic upgrade head
exec .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port "${E2E_API_PORT:?}" --log-level warning
