#!/usr/bin/env bash
# Retries `chain init` on devnet until all six comp defs exist and their
# circuits are uploaded. The public devnet RPC rate-limits aggressively and
# circuit upload is many transactions — this just keeps resuming (init is
# idempotent: existing defs are skipped, partial uploads resume).
set -uo pipefail
cd "$(dirname "$0")/.."
export ANCHOR_PROVIDER_URL=https://api.devnet.solana.com
export ARCIUM_CLUSTER_OFFSET=456 SEALED_CLUSTER_OFFSET=456
export NODE_NO_WARNINGS=1
for i in $(seq 1 60); do
  echo "=== init attempt $i $(date +%H:%M:%S)"
  out=$(yarn -s --cwd packages/harness cli chain init 2>&1 | grep -vE "429|Retrying|ws error")
  echo "$out"
  # success = all six defs report (exists|initialized) AND no exception thrown
  n=$(echo "$out" | grep -cE "comp def (exists|initialized)")
  if [ "$n" -ge 6 ] && ! echo "$out" | grep -qiE "error|fail"; then
    echo "=== all comp defs + circuits live on devnet"
    exit 0
  fi
  sleep 150
done
echo "=== exhausted init retries"
exit 1
