#!/usr/bin/env bash
# Wait until the sealed MXE account holds a finalized keygen result.
# Detection uses the same `getMXEPublicKey` the harness uses — it resolves
# the utility pubkey from the MXE account and fails until keygen lands.
# `arcium finalize-mxe-keys` completes that step if it stalls (see AGENTS.md).
set -uo pipefail
URL="${ANCHOR_PROVIDER_URL:-http://127.0.0.1:8899}"
WALLET="${ANCHOR_WALLET:-$HOME/.config/solana/id.json}"
cd "$(dirname "$0")/.."
for i in $(seq 1 90); do
  if npx tsx scripts/probe-mxe-live.mts "$URL" "$WALLET" 2>/dev/null | grep -q "^LIVE$"; then
    echo "MXE key live after ~$((i * 10))s"
    exit 0
  fi
  sleep 10
done
echo "MXE key never appeared"
exit 1
