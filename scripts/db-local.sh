#!/usr/bin/env bash
# Manage a project-local PostgreSQL cluster (data in .local/pgdata, localhost only).
# Uses PG_BIN if set, otherwise the binaries from the embedded-postgres npm dev dependency.
# The password is a local development default; the server is not reachable from other machines.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA="$ROOT/.local/pgdata"
LOG="$ROOT/.local/postgres.log"
PORT="${PGPORT_LOCAL:-55432}"
PY="$ROOT/apps/api/.venv/bin/python"

if [[ -z "${PG_BIN:-}" ]]; then
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) PLATFORM=darwin-arm64 ;;
    Darwin-x86_64) PLATFORM=darwin-x64 ;;
    Linux-x86_64) PLATFORM=linux-x64 ;;
    Linux-aarch64) PLATFORM=linux-arm64 ;;
    *) echo "Unsupported platform; set PG_BIN to a PostgreSQL bin directory" >&2; exit 1 ;;
  esac
  PG_BIN="$ROOT/node_modules/@embedded-postgres/$PLATFORM/native/bin"
fi

is_running() { "$PG_BIN/pg_ctl" -D "$DATA" status >/dev/null 2>&1; }

start() {
  mkdir -p "$ROOT/.local"
  if [[ ! -f "$DATA/PG_VERSION" ]]; then
    local pwfile
    pwfile="$(mktemp)"
    printf 'testforge_local' >"$pwfile"
    "$PG_BIN/initdb" -D "$DATA" -U testforge --pwfile="$pwfile" -A scram-sha-256 -E UTF8 --locale=C >/dev/null
    rm -f "$pwfile"
  fi
  if is_running; then
    echo "PostgreSQL already running on 127.0.0.1:$PORT"
  else
    "$PG_BIN/pg_ctl" -D "$DATA" -l "$LOG" -w -o "-p $PORT -h 127.0.0.1 -c unix_socket_directories=''" start >/dev/null
    echo "PostgreSQL started on 127.0.0.1:$PORT"
  fi
  "$PY" - "$PORT" <<'PY'
import sys
import psycopg
url = f"postgresql://testforge:testforge_local@127.0.0.1:{sys.argv[1]}/postgres"
with psycopg.connect(url, autocommit=True) as conn:
    for name in ("testforge", "testforge_test", "testforge_e2e"):
        if not conn.execute("SELECT 1 FROM pg_database WHERE datname = %s", (name,)).fetchone():
            conn.execute(f'CREATE DATABASE "{name}"')
            print(f"Created database {name}")
PY
}

case "${1:-}" in
  start) start ;;
  stop)
    if is_running; then "$PG_BIN/pg_ctl" -D "$DATA" -m fast -w stop >/dev/null; echo "PostgreSQL stopped"; else echo "PostgreSQL not running"; fi ;;
  status)
    if is_running; then echo "running on 127.0.0.1:$PORT"; else echo "stopped"; exit 1; fi ;;
  destroy)
    if is_running; then "$PG_BIN/pg_ctl" -D "$DATA" -m fast -w stop >/dev/null; fi
    rm -rf "$DATA"; echo "Removed $DATA" ;;
  *) echo "Usage: $0 {start|stop|status|destroy}" >&2; exit 2 ;;
esac
