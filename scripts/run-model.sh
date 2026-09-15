#!/usr/bin/env bash
# Run one model over a bank (reads .env for the API endpoint). Usage: scripts/run-model.sh <bank.json> <model> [extra cli args]
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
export NODE_NO_WARNINGS=1
BANK="$1"; MODEL="$2"; shift 2
yarn -s --cwd packages/harness cli run --bank "$BANK" --model "$MODEL" "$@"
