#!/usr/bin/env bash
# One-time setup from a fresh clone: install dependencies, start PostgreSQL, migrate and seed.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

bash scripts/install-deps.sh

bash scripts/db-local.sh start
npm run --silent db:reset
echo "Setup complete. Run: npm run dev"
