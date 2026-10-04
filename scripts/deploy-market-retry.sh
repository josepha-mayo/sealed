#!/usr/bin/env bash
# Retries `solana program deploy` of the hardened market build until the
# buffer write + finalize lands on devnet. Between attempts it closes any
# zombie buffer the failed deploy stranded (~3.1 SOL each) so the wallet
# stays funded across many attempts. Run detached:
#   setsid nohup scripts/deploy-market-retry.sh > /tmp/market-deploy.log 2>&1 &
set -uo pipefail
cd "$(dirname "$0")/.."
MARKET_PID=8VSHkhNLN3q3yBUhYmTjgKSCMA55VFzfLPXcgp4Z91vN
KEYPAIR="$HOME/.config/solana/id.json"

reclaim() {
  # Every buffer authority-owned by this wallet is a failed deploy leftover —
  # a completed deploy consumes its buffer. Reclaim the rent.
  solana program show --buffers -u devnet --keypair "$KEYPAIR" 2>/dev/null \
    | awk 'NR>2 && $1 ~ /^[1-9A-HJ-NP-Za-km-z]{32,}$/ {print $1}' \
    | while read -r buf; do
        echo "  reclaiming $buf"
        solana program close "$buf" -u devnet --keypair "$KEYPAIR" 2>&1 | tail -1
      done
}

# Reclaim leftovers from previous failed runs up front too — a stranded
# buffer locks ~3.1 SOL whether or not the next attempt succeeds.
reclaim

for i in $(seq 1 30); do
  echo "=== attempt $i $(date +%H:%M:%S)"
  if solana program deploy target/deploy/market.so \
      --program-id "$MARKET_PID" -u devnet \
      --keypair "$KEYPAIR"; then
    echo "=== DEPLOY_OK attempt $i"
    exit 0
  fi
  reclaim
  sleep 10
done
echo "=== still failing after 30 attempts"
exit 1
