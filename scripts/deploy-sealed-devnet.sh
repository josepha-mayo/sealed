#!/usr/bin/env bash
# deploy-sealed-devnet.sh — grind the sealed.so devnet redeploy through
# congestion; logs unbuffered so progress is visible while running.
set -uo pipefail
cd "$(dirname "$0")/.."
export PATH="/home/joseph/.local/share/solana/install/active_release/bin:$PATH"
stdbuf -oL -eL solana program deploy target/deploy/sealed.so \
  --program-id target/deploy/sealed-keypair.json \
  -u devnet --max-sign-attempts 2000 --use-quic
