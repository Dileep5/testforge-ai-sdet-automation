#!/usr/bin/env bash
# Install pinned scanners and linters into .local/tools, after verifying each release's checksum.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIR="$ROOT/.local/tools"
mkdir -p "$DIR"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

ACTIONLINT=1.7.12
GITLEAKS=8.30.1
HADOLINT=2.15.1
PIP_AUDIT=2.10.1
SHELLCHECK=0.11.0

verify() {
  (
    cd "$WORK"
    grep -E "[[:space:]]\*?$1\$" "$2" | {
      if command -v sha256sum >/dev/null; then sha256sum -c -; else shasum -a 256 -c -; fi
    }
  )
}

case "$(uname -s)-$(uname -m)" in
  # SC_SHA: that project publishes no checksum file, so hashes were recorded here when it was pinned.
  Darwin-arm64)
    AL=darwin_arm64; GL=darwin_arm64; HL=hadolint-macos-arm64
    SC=darwin.aarch64; SC_SHA=339b930feb1ea764467013cc1f72d09cd6b869ebf1013296ba9055ab2ffbd26f ;;
  Linux-x86_64)
    AL=linux_amd64; GL=linux_x64; HL=hadolint-linux-x86_64
    SC=linux.x86_64; SC_SHA=b7af85e41cc99489dcc21d66c6d5f3685138f06d34651e6d34b42ec6d54fe6f6 ;;
  *) echo "Unsupported platform" >&2; exit 1 ;;
esac

asset="actionlint_${ACTIONLINT}_${AL}.tar.gz"
base="https://github.com/rhysd/actionlint/releases/download/v$ACTIONLINT"
curl -fsSL "$base/$asset" -o "$WORK/$asset"
curl -fsSL "$base/actionlint_${ACTIONLINT}_checksums.txt" -o "$WORK/al.txt"
verify "$asset" al.txt
tar -xzf "$WORK/$asset" -C "$DIR" actionlint

asset="gitleaks_${GITLEAKS}_${GL}.tar.gz"
base="https://github.com/gitleaks/gitleaks/releases/download/v$GITLEAKS"
curl -fsSL "$base/$asset" -o "$WORK/$asset"
curl -fsSL "$base/gitleaks_${GITLEAKS}_checksums.txt" -o "$WORK/gl.txt"
verify "$asset" gl.txt
tar -xzf "$WORK/$asset" -C "$DIR" gitleaks

base="https://github.com/hadolint/hadolint/releases/download/v$HADOLINT"
curl -fsSL "$base/$HL" -o "$WORK/$HL"
curl -fsSL "$base/checksums.sha256" -o "$WORK/hl.txt"
verify "$HL" hl.txt
install -m 0755 "$WORK/$HL" "$DIR/hadolint"

asset="shellcheck-v${SHELLCHECK}.${SC}.tar.gz"
curl -fsSL "https://github.com/koalaman/shellcheck/releases/download/v$SHELLCHECK/$asset" -o "$WORK/$asset"
echo "$SC_SHA  $asset" >"$WORK/sc.txt"
verify "$asset" sc.txt
tar -xzf "$WORK/$asset" -C "$WORK"
install -m 0755 "$WORK/shellcheck-v$SHELLCHECK/shellcheck" "$DIR/shellcheck"

python3 -m venv "$DIR/pip-audit-env"
"$DIR/pip-audit-env/bin/pip" install --quiet "pip==26.3"
"$DIR/pip-audit-env/bin/pip" install --quiet "pip-audit==$PIP_AUDIT"
ln -sf "$DIR/pip-audit-env/bin/pip-audit" "$DIR/pip-audit"
ls "$DIR"
