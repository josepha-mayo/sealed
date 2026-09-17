#!/usr/bin/env bash
# Run a real model against a generated bank on localnet, then MPC-score it.
# Usage: scripts/gen-model-run.sh <bank.json> <model> [run-out.json]
set -uo pipefail
cd "$(dirname "$0")/.."
set -a && source .env && set +a
export ANCHOR_PROVIDER_URL="${ANCHOR_PROVIDER_URL:-http://127.0.0.1:8899}"
export SEALED_CLUSTER_OFFSET="${SEALED_CLUSTER_OFFSET:-0}"
BANK="$1"; MODEL="$2"; OUT="${3:-runs/$(basename "$BANK" .json)-${MODEL//\//_}.json}"
CLI="yarn -s --cwd packages/harness cli"

$CLI run --bank "$BANK" --model "$MODEL" --out "$OUT" || exit 1
$CLI chain score --bank "$BANK" --run "$OUT"
