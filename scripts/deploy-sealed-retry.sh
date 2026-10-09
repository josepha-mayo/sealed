#!/usr/bin/env bash
# Retry loop: deploy target/deploy/sealed.so to devnet until it lands.
# Reclaims zombie buffers between attempts. Log: ~/sealed-deploy.log
set -uo pipefail
cd "$HOME/code/sealed"
RPC="${SEALED_RPC_URL:-devnet}"
for i in $(seq 1 60); do
  echo "=== attempt $i $(date +%H:%M:%S)"
  out=$(solana program deploy target/deploy/sealed.so \
      --program-id FGVuEoWpDGTqBBuR9e26t2t5mDngXgbrAj5CtuLKXLUZ \
      -u "$RPC" --keypair "$HOME/.config/solana/id.json" \
      --with-compute-unit-price 1500 --max-sign-attempts 80 --use-rpc 2>&1 | tail -8)
  echo "$out"
  if echo "$out" | grep -q "Program Id:"; then echo "=== LANDED"; break; fi
  # reclaim stranded buffers so the wallet stays funded across attempts
  solana program show --buffers -u "$RPC" --keypair "$HOME/.config/solana/id.json" 2>/dev/null \
    | awk 'NR>2 && $1 ~ /^[1-9A-HJ-NP-Za-km-z]{32,}$/ {print $1}' \
    | while read -r buf; do
        echo "  reclaiming $buf"
        solana program close "$buf" -u "$RPC" --keypair "$HOME/.config/solana/id.json" 2>&1 | tail -1
      done
  sleep 15
done
