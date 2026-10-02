#!/usr/bin/env bash
# redeploy-local.sh — upgradeable redeploy of both programs to localnet
# (keeps deployed bytecode == committed source; no ledger wipe).
set -euo pipefail
cd "$(dirname "$0")/.."
S=/home/joseph/.local/share/solana/install/active_release/bin/solana
export PATH="$(dirname "$S"):$PATH"
RPC=http://127.0.0.1:8899
$S program deploy target/deploy/sealed.so \
  --program-id target/deploy/sealed-keypair.json \
  -u "$RPC" --keypair ~/.config/solana/id.json
$S program deploy target/deploy/market.so \
  --program-id target/deploy/market-keypair.json \
  -u "$RPC" --keypair ~/.config/solana/id.json
echo "redeploy complete"
