#!/usr/bin/env bash
# Real-model run on a minted bank via anonymous Pollinations (gpt-oss-20b).
# The free tier credit-walls in bursts — retry whole-run attempts until a
# valid artifact lands, then score it through MPC. The artifact binds to the
# bank's items_root, so chain score rejects a bank file that changed mid-run.
set -uo pipefail
cd "$(dirname "$0")/.."
export SEALED_API_BASE="https://text.pollinations.ai/openai"
export SEALED_API_KEY="anonymous"
export ARCIUM_CLUSTER_OFFSET=0
export ANCHOR_PROVIDER_URL="http://127.0.0.1:8899"
export ANCHOR_WALLET="$HOME/.config/solana/id.json"
BANK="${BANK:-$PWD/packages/harness/bank/gen-25864.json}"
OUT="${OUT:-/home/joseph/run-real.json}"
CLI="yarn --cwd packages/harness --silent tsx src/cli.ts"
for i in $(seq 1 60); do
  echo "=== attempt $i $(date -u +%T)"
  if $CLI run --bank "$BANK" --model openai --concurrency 1 --max-tokens 512 --retries 15 --out "$OUT" 2>&1 | tail -5; then
    if [ -f "$OUT" ] && python3 - "$OUT" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
print("itemsRoot", d.get("itemsRoot"), "localCorrect", d.get("localCorrect"))
sys.exit(0 if d.get("localCorrect", 0) > 0 else 1)
PY
    then
      echo "=== artifact landed: $OUT — scoring"
      $CLI chain score --bank "$BANK" --run "$OUT" 2>&1 | tail -15
      break
    fi
  fi
  sleep 30
done
echo "=== done $(date -u +%T)"
