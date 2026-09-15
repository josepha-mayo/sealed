#!/usr/bin/env bash
# Install the Solana CLI straight from Anza's CDN tarball. The official installer
# pulls from GitHub releases, which can be painfully slow on some routes.
set -euo pipefail
VERSION="${1:-3.1.10}"
BASE="$HOME/.local/share/solana/install"
mkdir -p "$BASE/releases/$VERSION"
curl -sSL "https://release.anza.xyz/v${VERSION}/solana-release-x86_64-unknown-linux-gnu.tar.bz2" \
  | tar xj -C "$BASE/releases/$VERSION"
ln -sfn "$BASE/releases/$VERSION/solana-release" "$BASE/active_release"
if ! grep -q 'solana/install/active_release/bin' "$HOME/.profile"; then
  echo 'export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"' >> "$HOME/.profile"
fi
"$BASE/active_release/bin/solana" --version
