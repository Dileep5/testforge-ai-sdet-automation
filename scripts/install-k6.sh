#!/usr/bin/env bash
# Install a pinned k6 into .local/k6 from the official release, after verifying its checksum.
set -euo pipefail
VERSION="v2.3.0"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIR="$ROOT/.local/k6"
BIN="$DIR/k6"

if [[ -x "$BIN" ]] && "$BIN" version | grep -q "${VERSION#v}"; then
  echo "k6 $VERSION already installed at $BIN"
  exit 0
fi

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) ASSET="k6-$VERSION-macos-arm64.zip" ;;
  Darwin-x86_64) ASSET="k6-$VERSION-macos-amd64.zip" ;;
  Linux-x86_64) ASSET="k6-$VERSION-linux-amd64.tar.gz" ;;
  Linux-aarch64) ASSET="k6-$VERSION-linux-arm64.tar.gz" ;;
  *) echo "Unsupported platform" >&2; exit 1 ;;
esac

BASE="https://github.com/grafana/k6/releases/download/$VERSION"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
curl -fsSL "$BASE/$ASSET" -o "$WORK/$ASSET"
curl -fsSL "$BASE/k6-$VERSION-checksums.txt" -o "$WORK/checksums.txt"
(cd "$WORK" && grep " $ASSET\$" checksums.txt | shasum -a 256 -c -)

mkdir -p "$DIR" "$WORK/out"
case "$ASSET" in
  *.zip) unzip -q "$WORK/$ASSET" -d "$WORK/out" ;;
  *) tar -xzf "$WORK/$ASSET" -C "$WORK/out" ;;
esac
find "$WORK/out" -type f -name k6 -exec cp {} "$BIN" \;
chmod +x "$BIN"
"$BIN" version
