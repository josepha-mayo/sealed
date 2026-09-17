#!/bin/bash
# Waits for the devnet gen (or seal) to land, then runs the market e2e.
cd /home/joseph/code/sealed
for i in $(seq 1 480); do
  if grep -qE "benchmark LIVE on devnet" ~/seal-devnet.log ~/gen-devnet.log 2>/dev/null; then
    echo "bank LIVE — running devnet-e2e" >> ~/devnet-e2e.log
    ANCHOR_PROVIDER_URL=https://api.devnet.solana.com ARCIUM_CLUSTER_OFFSET=456 \
      ANCHOR_WALLET=$HOME/.config/solana/id.json \
      bash scripts/devnet-e2e.sh >> ~/devnet-e2e.log 2>&1
    exit 0
  fi
  if grep -qE "exhausted (gen |seal )?retries" ~/seal-devnet.log ~/gen-devnet.log 2>/dev/null; then
    echo "retry loop exhausted without success" >> ~/devnet-e2e.log
    exit 1
  fi
  sleep 60
done
