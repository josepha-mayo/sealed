#!/usr/bin/env bash
# One-shot devnet deployment. Needs ~13 SOL on ~/.config/solana/id.json (devnet):
# sealed.so 665KB ≈ 4.6 + market.so 229KB ≈ 1.6 + circuits ~890KB ≈ 6.2 + MXE/comp-defs.
# Usage: scripts/deploy-devnet.sh
set -euo pipefail
cd "$(dirname "$0")/.."
RPC="https://api.devnet.solana.com"
export ANCHOR_PROVIDER_URL="$RPC"
export ARCIUM_CLUSTER_OFFSET=456
export SEALED_CLUSTER_OFFSET=456
export NODE_NO_WARNINGS=1

BAL=$(solana balance --url "$RPC" | awk '{print $1}')
echo "deployer balance: $BAL SOL"
awk -v b="$BAL" 'BEGIN{exit !(b+0>=13)}' || { echo "need ~13 SOL (have $BAL); keep claiming the faucet"; exit 1; }

echo "== arcium deploy (program + MXE init, cluster offset 456)"
arcium deploy --cluster-offset 456 --recovery-set-size 4 -n sealed \
  --keypair-path "$HOME/.config/solana/id.json" --rpc-url "$RPC"

echo "== market program deploy"
solana program deploy target/deploy/market.so --url "$RPC" \
  --program-id target/deploy/market-keypair.json

echo "== comp defs + circuit upload"
yarn -s --cwd packages/harness cli chain init

echo "done. Seal a bank with: yarn -s --cwd packages/harness cli chain seal --bank <bank.json>"
