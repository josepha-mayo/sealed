#!/usr/bin/env bash
# Rebuilds the localnet demo after a validator restart:
#   chain init (comp defs + circuits) -> seal bank-7 -> score the two real runs
#   -> reopen the threshold market on a parked run.
set -uo pipefail
cd "$(dirname "$0")/.."
export ARCIUM_CLUSTER_OFFSET=0
export ANCHOR_PROVIDER_URL=http://127.0.0.1:8899
export NODE_NO_WARNINGS=1
CLI="yarn -s --cwd packages/harness cli"

echo "== waiting for arx cluster (localnet)..."
for i in $(seq 1 60); do
  if $CLI chain init 2>&1 | grep -qE 'comp def|uploaded|exists'; then break; fi
  sleep 10
done
$CLI chain init

echo "== seal bank-7"
$CLI chain seal --bank ~/sealed-data/bank-7.json --fee-lamports 1000000

echo "== score ling run"
$CLI chain score --bank ~/sealed-data/bank-7.json --run ~/sealed-data/run-ling-7.json

echo "== park nemotron run for market demo"
$CLI chain score --bank ~/sealed-data/bank-7.json --run ~/sealed-data/run-nemotron-7.json --create-only

echo "== status"
$CLI chain status --benchmark 2wwqt9Y9mL6tkKAdfrN5YcTHNG4r59sdZWou3k2hezg4
