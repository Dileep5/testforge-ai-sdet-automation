#!/usr/bin/env bash
# Build and start the application stack, and prove that data survives a restart. Needs Docker.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
PORT="${WEB_PORT:-18080}"
ENV_FILE="$(mktemp)"
JAR="$(mktemp)"
# A password made for this run, which is never stored.
cat >"$ENV_FILE" <<ENV
POSTGRES_USER=testforge
POSTGRES_PASSWORD=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
POSTGRES_DB=testforge
WEB_PORT=$PORT
ENV
compose() { docker compose --env-file "$ENV_FILE" -p testforge-smoke -f compose.yaml "$@"; }
cleanup() {
  compose down -v --remove-orphans >/dev/null 2>&1
  rm -f "$ENV_FILE" "$JAR"
}
trap cleanup EXIT

BASE="http://127.0.0.1:$PORT"
ORIGIN="Origin: http://localhost:$PORT"
login() {
  curl -fsS -c "$JAR" -H 'Content-Type: application/json' -H "$ORIGIN" \
    -d '{"email":"admin@testforge.example","password":"Admin!Forge2026"}' "$BASE/api/v1/auth/login" >/dev/null
}

compose up --build --detach --wait
echo "Started. Containers:"
compose ps --format '{{.Service}} {{.Status}}'

curl -fsS "$BASE/" | grep -q '<div id="root">'
echo "Web app served"
curl -fsS "$BASE/api/v1/ready"
echo
login
CODE="SMOKE-$(date +%s)"
curl -fsS -b "$JAR" -H 'Content-Type: application/json' -H "$ORIGIN" \
  -d "{\"code\":\"$CODE\",\"name\":\"Smoke $CODE\",\"contact_email\":\"smoke@docker.example\"}" \
  "$BASE/api/v1/customers" >/dev/null
echo "Created customer $CODE"

compose down
echo "Stopped, keeping the volume"
compose up --detach --wait
login
curl -fsS -b "$JAR" "$BASE/api/v1/customers?page_size=100" | grep -q "$CODE"
echo "Customer $CODE survived a restart"
