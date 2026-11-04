#!/usr/bin/env bash
# Static checks for the repository's own scripts. Needs `npm run ci:tools` for shellcheck.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
SHELLCHECK=".local/tools/shellcheck"
RUFF="apps/api/.venv/bin/ruff"

if [[ ! -x "$SHELLCHECK" ]]; then
  echo "shellcheck is not installed. Run: npm run ci:tools" >&2
  exit 1
fi

echo "Python scripts: Ruff"
"$RUFF" check scripts --config ai/pyproject.toml
"$RUFF" format --check scripts --config ai/pyproject.toml

tracked() { git ls-files "$1"; }

echo "Shell scripts: syntax"
while IFS= read -r script; do
  # A script's own first line says which shell runs it.
  if head -1 "$script" | grep -q bash; then bash -n "$script"; else sh -n "$script"; fi
done < <(tracked '*.sh')

echo "Shell scripts: shellcheck"
tracked '*.sh' | xargs "$SHELLCHECK"

echo "Node scripts: syntax"
while IFS= read -r script; do
  node --check "$script"
done < <(tracked 'scripts/*.mjs')

echo "All script checks passed"
