#!/usr/bin/env bash
# Retries `solana program deploy` of the hardened market build until the
# buffer write + finalize lands on devnet. Run detached:
#   setsid nohup scripts/deploy-market-retry.sh > /tmp/market-deploy.log 2>&1 &
set -uo pipefail
cd "$(dirname "$0")/.."
MARKET_PID=8VSHkhNLN3q3yBUhYmTjgKSCMA55VFzfLPXcgp4Z91vN
for i in $(seq 1 30); do
  echo "=== attempt $i $(date +%H:%M:%S)"
  if solana program deploy target/deploy/market.so \
      --program-id "$MARKET_PID" -u devnet \
      --keypair "$HOME/.config/solana/id.json"; then
    echo "=== DEPLOY_OK attempt $i"
    exit 0
  fi
  sleep 10
done
echo "=== still failing after 30 attempts"
exit 1
