#!/usr/bin/env bash
# Retries `chain init` until the devnet RPC stops 429-ing us.
set -uo pipefail
cd "$(dirname "$0")/.."
export ARCIUM_CLUSTER_OFFSET=456 SEALED_CLUSTER_OFFSET=456
export ANCHOR_PROVIDER_URL=https://api.devnet.solana.com
export NODE_NO_WARNINGS=1
for i in $(seq 1 30); do
  echo "=== attempt $i $(date +%H:%M:%S)"
  if yarn -s --cwd packages/harness cli chain init 2>&1 | tail -10; then
    echo "=== chain init done"
    exit 0
  fi
  sleep 60
done
echo "=== still failing after 30 attempts"
exit 1
