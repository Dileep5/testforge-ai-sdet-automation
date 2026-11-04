#!/usr/bin/env bash
# Install pinned Node and Python dependencies. Used by local setup and by CI.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

npm ci
if [[ ! -x apps/api/.venv/bin/python ]]; then
  python3 -m venv apps/api/.venv
fi
apps/api/.venv/bin/pip install --quiet --upgrade pip
apps/api/.venv/bin/pip install --quiet -r apps/api/requirements.lock -r ai/requirements.lock
apps/api/.venv/bin/pip install --quiet --no-deps -e ai
