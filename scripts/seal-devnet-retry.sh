#!/usr/bin/env bash
# Devnet seal retry loop: the Arcium devnet cluster (offset 456) finalizes
# computations but is currently not submitting callback txs. This clears the
# stuck sealing_part flag and retries `chain seal` until the bank is LIVE.
set -uo pipefail
cd "$(dirname "$0")/.."
export ARCIUM_CLUSTER_OFFSET=456 SEALED_CLUSTER_OFFSET=456
export ANCHOR_PROVIDER_URL=https://api.devnet.solana.com
export NODE_NO_WARNINGS=1
BANK="${1:-$HOME/sealed-data/bank-7.json}"
# The reset path needs the numeric id — read it from the bank file itself so a
# non-default BANK can't reset the wrong benchmark.
BID=$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).benchmarkId)" "$BANK")
for i in $(seq 1 40); do
  echo "=== seal attempt $i $(date +%H:%M:%S)"
  out=$(yarn -s --cwd packages/harness cli chain seal --bank "$BANK" --fee-lamports 1000000 2>&1 | tail -12)
  echo "$out"
  if echo "$out" | grep -q "status=LIVE"; then
    echo "=== benchmark LIVE on devnet"
    exit 0
  fi
  if echo "$out" | grep -q "PartSealPending"; then
    for c in 0 1 2 3 4 5 6 7 8 9; do
      yarn -s --cwd packages/harness cli chain reset-sealing --bank-id "$BID" --chunk "$c" 2>/dev/null | tail -1 || true
    done
  fi
  sleep 120
done
echo "=== exhausted retries"
exit 1
