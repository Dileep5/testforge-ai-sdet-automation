#!/usr/bin/env bash
# Install Playwright browsers and their Linux packages in CI, within a time limit.
#
# Some runners get a very slow package mirror: 114 MB took 8 seconds on one job and over 15 minutes
# on another in the same run. So downloaded packages go in a folder that CI caches, and a stalled
# install fails here with a clear message, rather than using up the time meant for the tests.
#
# Every job installs the system packages for all browsers, even if it runs only one. That makes the
# set the same everywhere, so one cache serves every job, whichever job filled it.
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

# shellcheck disable=SC2016 # The inner shell expands "$@".
timeout "${LIMIT_MINUTES}m" bash -c 'npx playwright install-deps && npx playwright install "$@"' _ "$@"
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
