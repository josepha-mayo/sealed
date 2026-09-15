#!/usr/bin/env bash
# Full CLI pipeline against a running `arcium localnet` (cluster offset 0):
# build a small bank -> offline mock run -> chain init/seal/score/status.
# Usage: scripts/smoke-localnet.sh [id=7] [chunks=2] [p=0.6] [--skip-bank]
set -euo pipefail
cd "$(dirname "$0")/.."
export ARCIUM_CLUSTER_OFFSET="${ARCIUM_CLUSTER_OFFSET:-0}"
export ANCHOR_PROVIDER_URL="${ANCHOR_PROVIDER_URL:-http://127.0.0.1:8899}"
export NODE_NO_WARNINGS=1
ID="${1:-7}"
CHUNKS="${2:-2}"
P="${3:-0.6}"
BANK="/tmp/sealed-bank-$ID.json"
RUN="/tmp/sealed-run-$ID.json"
cli() { yarn -s --cwd packages/harness cli "$@"; }

if [ "${4:-}" != "--skip-bank" ]; then
  cli bank build --seed "smoke-seed-$ID" --id "$ID" --chunks "$CHUNKS" --out "$BANK" | head -6
  cli run --bank "$BANK" --model "mock/oracle-$P" --out "$RUN" 2>/dev/null | grep -E 'localCorrect|items'
fi
cli chain init
cli chain seal --bank "$BANK" --fee-lamports 1000000
cli chain score --bank "$BANK" --run "$RUN"
BENCH=$(cli chain seal --bank "$BANK" | grep -o 'benchmark [A-Za-z0-9]* status=LIVE' | head -1 | cut -d' ' -f2)
cli chain status --benchmark "$BENCH"
