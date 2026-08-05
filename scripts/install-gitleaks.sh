#!/usr/bin/env bash
set -euo pipefail

version=8.28.0
case "$(uname -m)" in
  x86_64) archive="gitleaks_${version}_linux_x64.tar.gz"; digest=a65b5253807a68ac0cafa4414031fd740aeb55f54fb7e55f386acb52e6a840eb ;;
  aarch64|arm64) archive="gitleaks_${version}_linux_arm64.tar.gz"; digest=eff65261156100e5d94a6b3dec313d532fddfe19ae1590bf7a2b4f2699128356 ;;
  *) echo "Unsupported architecture for pinned gitleaks installer" >&2; exit 1 ;;
esac
destination="${1:-$PWD/.tools/gitleaks}"
temporary="$(mktemp -d)"
trap 'rm -rf -- "$temporary"' EXIT
curl --fail --silent --show-error --location \
  "https://github.com/gitleaks/gitleaks/releases/download/v${version}/${archive}" \
  --output "$temporary/$archive"
printf '%s  %s\n' "$digest" "$temporary/$archive" | sha256sum --check --status
tar -xzf "$temporary/$archive" -C "$temporary" gitleaks
install -D -m 0755 "$temporary/gitleaks" "$destination"
"$destination" version | grep -Fx "$version" >/dev/null
