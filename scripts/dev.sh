#!/usr/bin/env bash
# Run PostgreSQL, the API and the web app together. Ctrl+C stops the API and web app;
# PostgreSQL keeps running until `npm run db:stop`.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

bash scripts/db-local.sh start
(cd apps/api && .venv/bin/alembic upgrade head)

(cd apps/api && exec .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload --reload-dir app) &
API_PID=$!
npm run --silent dev -w apps/web &
WEB_PID=$!
trap 'kill "$API_PID" "$WEB_PID" 2>/dev/null || true' EXIT INT TERM
# Stop everything as soon as either process exits (`wait -n` is missing from macOS's Bash 3.2).
while kill -0 "$API_PID" 2>/dev/null && kill -0 "$WEB_PID" 2>/dev/null; do
  sleep 1
done
