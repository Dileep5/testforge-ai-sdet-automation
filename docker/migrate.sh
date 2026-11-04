#!/bin/sh
# Apply migrations, then seed. SEED_MODE=reset replaces all data, and is for the test stack only.
set -eu
alembic upgrade head
case "${SEED_MODE:-if-empty}" in
  reset) python -m app.seed --reset ;;
  if-empty) python -m app.seed --if-empty ;;
  none) echo "Seeding skipped" ;;
  *) echo "Unknown SEED_MODE: $SEED_MODE" >&2; exit 2 ;;
esac
