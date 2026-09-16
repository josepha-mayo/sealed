#!/usr/bin/env bash
# Retries `arcium deploy` until the program buffer write + MXE init land on devnet.
set -uo pipefail
cd "$(dirname "$0")/.."
RPC="https://api.devnet.solana.com"
for i in $(seq 1 20); do
  echo "=== attempt $i $(date +%H:%M:%S)"
  if arcium deploy --cluster-offset 456 --recovery-set-size 4 -n sealed \
      --keypair-path "$HOME/.config/solana/id.json" --rpc-url "$RPC" --resume; then
    echo "=== deploy+init succeeded on attempt $i"
    exit 0
  fi
  sleep 5
done
echo "=== still failing after 20 attempts"
exit 1
