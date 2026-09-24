#!/usr/bin/env bash
# A REAL model takes an exam it could only see through an on-chain grant:
# reshare a private bank's specs to a delegate key inside MPC, let the
# delegate rebuild the bank from grants alone, run gpt-oss-20b against it,
# and score through MPC. The questions were never published anywhere —
# the model's only view of the exam is the ShareGrant trail on-chain.
#
# Usage: scripts/real-unseen-run.sh <benchmark-pda> [bank-json]
#   bank-json defaults to the delegate's rebuilt file (produced here).
# Needs: running localnet + MXE live; SEALED_API_* for the real model.
set -euo pipefail
cd "$(dirname "$0")/.."
export ANCHOR_PROVIDER_URL="${ANCHOR_PROVIDER_URL:-http://127.0.0.1:8899}"
export SEALED_CLUSTER_OFFSET="${SEALED_CLUSTER_OFFSET:-0}"
export SEALED_API_BASE="${SEALED_API_BASE:-https://text.pollinations.ai/openai}"
export SEALED_API_KEY="${SEALED_API_KEY:-anonymous}"
SEALED="yarn -s --cwd packages/harness cli"
PBENCH="${1:?usage: real-unseen-run.sh <benchmark-pda>}"

say() { printf '\n=== %s ===\n' "$*"; }

say "1/4 delegate key + reshare every part of chunk 0 to it inside MPC"
JUDGE=$(node -e 'const {Keypair}=require("@solana/web3.js");const k=Keypair.generate();require("fs").writeFileSync("/tmp/rt-judge.json",JSON.stringify([...k.secretKey]));console.log(k.publicKey.toBase58())')
solana airdrop 1 "$JUDGE" --url "$ANCHOR_PROVIDER_URL" >/dev/null 2>&1 || true
for p in 0 1 2 3; do $SEALED chain reshare --benchmark "$PBENCH" --chunk 0 --part "$p" --to "$JUDGE"; sleep 2; done
echo "grant trail:"; $SEALED chain grants --benchmark "$PBENCH"

say "2/4 delegate rebuilds the bank from grants alone"
JBANK=/tmp/rt-judge-bank.json
ANCHOR_WALLET=/tmp/rt-judge.json $SEALED chain delegate-bank --benchmark "$PBENCH" --out "$JBANK"

say "3/4 real model (gpt-oss-20b) answers items it could only see via grant"
ART=/tmp/rt-run.json
for att in 1 2 3 4 5 6 7 8; do
  echo "--- attempt $att $(date -u +%T) ---"
  ANCHOR_WALLET=/tmp/rt-judge.json $SEALED run --bank "$JBANK" --model openai \
    --concurrency 1 --retries 15 --timeout 90000 --max-tokens 512 --out "$ART" && break
  sleep 20
done
[ -s "$ART" ] || { echo "model never produced a full artifact — provider credit-walled"; exit 1; }

say "4/4 judge wallet scores the run through MPC"
ANCHOR_WALLET=/tmp/rt-judge.json $SEALED chain score --bank "$JBANK" --run "$ART" \
  --authority "$(solana address --keypair ~/.config/solana/id.json)"
echo "DONE — a real model took an exam that was never published."
