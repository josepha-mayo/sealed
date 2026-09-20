#!/usr/bin/env bash
# Retry a real-model run against bank gen-25864 until a valid artifact lands,
# then score it through MPC. Anonymous Pollinations walls come in bursts —
# per-item retries + whole-run attempts grind through the gaps.
set -u
cd /home/joseph/code/sealed
BANK=/home/joseph/code/sealed/packages/harness/bank/gen-25864.json
OUT=/home/joseph/run-real-25864-v2.json
export ARCIUM_CLUSTER_OFFSET=0 SEALED_API_BASE=https://text.pollinations.ai/openai SEALED_API_KEY=anonymous
for i in $(seq 1 60); do
  echo "=== attempt $i $(date +%T) ==="
  if yarn --cwd packages/harness --silent tsx src/cli.ts run \
      --bank "$BANK" --model openai --concurrency 1 --max-tokens 512 \
      --retries 15 --out "$OUT" 2>&1 | tail -4; then
    if [ -f "$OUT" ] && python3 - "$OUT" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
print("itemsRoot", d.get("itemsRoot"), "localCorrect", d.get("localCorrect"))
sys.exit(0 if d.get("localCorrect", 0) > 0 else 1)
PY
    then
      echo "=== artifact OK — scoring ==="
      yarn --cwd packages/harness --silent tsx src/cli.ts chain score \
        --bank "$BANK" --run "$OUT" 2>&1 | tail -12
      exit 0
    fi
  fi
  sleep 30
done
echo "exhausted attempts"
exit 1
