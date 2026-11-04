#!/usr/bin/env bash
# One-time setup from a fresh clone: install dependencies, start PostgreSQL, migrate and seed.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

npm ci
if [[ ! -x apps/api/.venv/bin/python ]]; then
  python3 -m venv apps/api/.venv
fi
apps/api/.venv/bin/pip install --quiet --upgrade pip
apps/api/.venv/bin/pip install --quiet -r apps/api/requirements.lock

bash scripts/db-local.sh start
npm run --silent db:reset
echo "Setup complete. Run: npm run dev"
