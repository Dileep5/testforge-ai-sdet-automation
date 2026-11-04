#!/usr/bin/env bash
# Install Playwright browsers and their Linux packages in CI, within a time limit.
#
# One runner's package mirror once delivered 114 MB in 32 minutes, leaving that job 12 seconds short
# of its timeout. So downloaded packages go in a folder that CI caches, and a stalled install fails
# here with a clear message, rather than using up the time meant for the tests.
#
# Usage: install-browsers.sh <browser> [<browser> ...]
set -uo pipefail

LIMIT_MINUTES="${BROWSER_INSTALL_LIMIT_MINUTES:-15}"
ARCHIVES="${APT_ARCHIVES_DIR:-$HOME/.cache/apt-archives}"
APT_CONF="${APT_CONF_FILE:-/etc/apt/apt.conf.d/99testforge-cache}"

count_packages() { find "$ARCHIVES" -maxdepth 1 -name '*.deb' | wc -l | tr -d ' '; }

mkdir -p "$ARCHIVES/partial"
sudo tee "$APT_CONF" >/dev/null <<APT
Dir::Cache::Archives "$ARCHIVES/";
Acquire::Retries "3";
Acquire::http::Timeout "30";
APT

before="$(count_packages)"
echo "Package cache: $before packages before installing"

timeout "${LIMIT_MINUTES}m" npx playwright install --with-deps "$@"
status=$?

# apt runs as root, and the cache step that follows does not.
sudo chown -R "$(id -u):$(id -g)" "$ARCHIVES"
rm -rf "$ARCHIVES/partial" "$ARCHIVES/lock"

echo "Package cache: $(count_packages) packages after installing. Took ${SECONDS}s."
if [[ "$status" -eq 124 ]]; then
  echo "::error title=Browser install timed out::Stopped after ${LIMIT_MINUTES} minutes. This is usually a slow package mirror, not a test or application failure. Check the download speed in this step's log."
elif [[ "$status" -ne 0 ]]; then
  echo "::error title=Browser install failed::playwright install exited with $status, before any test ran."
fi
exit "$status"
