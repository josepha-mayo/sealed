#!/usr/bin/env bash
# Devnet gen retry loop: the Arcium devnet cluster (offset 456) finalizes
# computations but is currently not submitting callback txs. This clears the
# stuck sealing_part flag and retries `chain gen` until the generated bank is
# LIVE. Generated banks are the better devnet demo anyway: 4 mint computations
# per chunk vs. staged+sealed authored flow, and no answer key exists at all.
set -uo pipefail
cd "$(dirname "$0")/.."
export ARCIUM_CLUSTER_OFFSET=456 SEALED_CLUSTER_OFFSET=456
export ANCHOR_PROVIDER_URL=https://api.devnet.solana.com
export NODE_NO_WARNINGS=1
ID="${1:-1007}"
CHUNKS="${2:-1}"
CLI="yarn -s --cwd packages/harness cli"
for i in $(seq 1 60); do
  echo "=== gen attempt $i $(date +%H:%M:%S)"
  out=$($CLI chain gen --id "$ID" --chunks "$CHUNKS" --fee-lamports 1000000 2>&1 | tail -15)
  echo "$out"
  if echo "$out" | grep -q "status=LIVE"; then
    echo "=== generated benchmark LIVE on devnet"
    exit 0
  fi
  # a stuck gen_part leaves sealing_part set — clear it and retry
  for c in 0 1 2 3; do
    $CLI chain reset-sealing --bank-id "$ID" --chunk "$c" 2>/dev/null | tail -1 || true
  done
  sleep 120
done
echo "=== exhausted gen retries"
exit 1
