#!/usr/bin/env bash
# Real-model run on the MPC-minted gen bank (id 6932) — restores the
# "real model answers items minted inside MPC" headline on the v4 ledger.
# Pollinations anonymous tier: no auth header, --max-tokens 512 cap,
# credit-walls in bursts so we retry the whole run.
cd /home/joseph/code/sealed/packages/harness
export ARCIUM_CLUSTER_OFFSET=0 ANCHOR_PROVIDER_URL=http://127.0.0.1:8899
export ANCHOR_WALLET=/home/joseph/.config/solana/id.json
export SEALED_API_BASE=https://text.pollinations.ai/openai SEALED_API_KEY=anonymous
BANK=/home/joseph/code/sealed/packages/harness/bank/gen-6932.json
ART=/tmp/run-gen-real.json
for att in 1 2 3 4 5 6 7 8; do
  echo "=== attempt $att $(date -u +%T) ==="
  npx tsx src/cli.ts run --bank "$BANK" --model openai --concurrency 1 --retries 15 --timeout 90000 --max-tokens 512 --out "$ART" && break
  sleep 20
done
if [ -s "$ART" ]; then
  npx tsx src/cli.ts chain score --bank "$BANK" --run "$ART"
fi
echo DONE
