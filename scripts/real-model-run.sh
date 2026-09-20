#!/usr/bin/env bash
# Real-model run on bank 25864 via anonymous Pollinations (gpt-oss-20b).
# Retries the artifact build until it lands, then scores through MPC.
set -uo pipefail
cd "$(dirname "$0")/.."
export SEALED_API_BASE="https://text.pollinations.ai/openai"
export SEALED_API_KEY="anonymous"
export ARCIUM_CLUSTER_OFFSET=0
export ANCHOR_PROVIDER_URL="http://127.0.0.1:8899"
export ANCHOR_WALLET="$HOME/.config/solana/id.json"
BANK="/home/joseph/code/sealed/packages/harness/bank/gen-25864.json"
OUT="/home/joseph/run-real-25864.json"
CLI="yarn --cwd packages/harness --silent tsx src/cli.ts"
for i in $(seq 1 40); do
  echo "=== attempt $i $(date -u +%T)"
  if $CLI run --bank "$BANK" --model openai --concurrency 1 --max-tokens 512 --retries 15 --out "$OUT" 2>&1 | tail -5; then
    if [ -f "$OUT" ]; then
      echo "=== artifact landed: $OUT"
      python3 -c "import json;d=json.load(open('$OUT'));print('localCorrect:',d['localCorrect'])"
      break
    fi
  fi
  sleep 20
done
[ -f "$OUT" ] && $CLI chain score --bank "$BANK" --run "$OUT" 2>&1 | tail -20
echo "=== done $(date -u +%T)"
