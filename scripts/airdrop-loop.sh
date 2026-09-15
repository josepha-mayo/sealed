#!/usr/bin/env bash
# Retry devnet airdrops until we have >= TARGET SOL. Usage: scripts/airdrop-loop.sh [target]
set -uo pipefail
TARGET="${1:-8}"
while true; do
  BAL=$(solana balance --url devnet 2>/dev/null | awk '{print $1}')
  BAL=${BAL:-0}
  echo "$(date +%H:%M:%S) balance=${BAL} target=${TARGET}"
  if awk -v b="$BAL" -v t="$TARGET" 'BEGIN{exit !(b>=t)}'; then
    echo "DONE balance=$BAL"
    exit 0
  fi
  solana airdrop 1 --url devnet 2>&1 | tail -1
  sleep 45
done
