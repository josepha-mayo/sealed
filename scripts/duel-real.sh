#!/usr/bin/env bash
# Real-model duel: a REAL model vs a published mock baseline on the same
# MPC-minted exam. The duel market opens and bets latch while BOTH runs
# are still pending — nobody can trade on a score that doesn't exist yet —
# then the market settles permissionlessly from the MPC-written counts.
#
# Chain-of-custody: bank specs+answers born inside MPC (no plaintext key
# exists) -> both artifacts commit outputs_root before scoring -> the
# market resolves on Run.correct written by the score_chunk callback.
#
# Requires: localnet up + MXE live. Anonymous Pollinations credit-walls in
# bursts, so the real-model leg retries whole-run attempts until a valid
# artifact lands. Usage: scripts/duel-real.sh [bank-id-seed]
set -uo pipefail
cd "$(dirname "$0")/.."
# solana lives under the release installer on fresh machines.
command -v solana >/dev/null 2>&1 || \
  export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
export SEALED_API_BASE="${SEALED_API_BASE:-https://text.pollinations.ai/openai}"
export SEALED_API_KEY="${SEALED_API_KEY:-anonymous}"
export ARCIUM_CLUSTER_OFFSET=0
export ANCHOR_PROVIDER_URL="${ANCHOR_PROVIDER_URL:-http://127.0.0.1:8899}"
export ANCHOR_WALLET="${ANCHOR_WALLET:-$HOME/.config/solana/id.json}"
SEALED="yarn --cwd packages/harness --silent tsx src/cli.ts"
MODEL="${MODEL:-openai}"
SEED="${1:-duel-$(date +%s)}"
ID=$(node -e "console.log(require('crypto').createHash('sha256').update('duel/' + process.argv[1]).digest().readUInt32LE(0) % 100000)" "$SEED")

say() { printf '\n=== %s ===\n' "$*"; }

PDA() { # PDA <market|run|benchmark|duel> <args...>
  node - "$@" <<'EOF'
const { PublicKey, Keypair } = require("@solana/web3.js");
const { readFileSync } = require("fs");
const { homedir } = require("os");
const SEALED = new PublicKey("FGVuEoWpDGTqBBuR9e26t2t5mDngXgbrAj5CtuLKXLUZ");
const MARKET = new PublicKey("8VSHkhNLN3q3yBUhYmTjgKSCMA55VFzfLPXcgp4Z91vN");
const le = (n, w) => { const b = Buffer.alloc(w); w === 4 ? b.writeUInt32LE(Number(n)) : b.writeBigUInt64LE(BigInt(n)); return b; };
const wallet = () => Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(process.env.ANCHOR_WALLET ?? `${homedir()}/.config/solana/id.json`, "utf8")))).publicKey;
const [kind, a, i, j] = process.argv.slice(2);
const pda = kind === "benchmark"
  ? PublicKey.findProgramAddressSync([Buffer.from("benchmark"), wallet().toBuffer(), le(a, 4)], SEALED)
  : kind === "run"
  ? PublicKey.findProgramAddressSync([Buffer.from("run"), new PublicKey(a).toBuffer(), le(i, 8)], SEALED)
  : kind === "duel"
  ? PublicKey.findProgramAddressSync([Buffer.from("duel"), new PublicKey(a).toBuffer(), new PublicKey(i).toBuffer(), le(j ?? 0, 8)], MARKET)
  : PublicKey.findProgramAddressSync([Buffer.from("market"), new PublicKey(a).toBuffer(), le(i ?? 0, 8)], MARKET);
console.log(pda[0].toBase58());
EOF
}

say "1/6 wait for MXE, then comp defs + circuits (once per deployment)"
scripts/wait-mxe.sh
$SEALED chain init

say "2/6 mint the exam INSIDE MPC (id=$ID, 32 items — no answer key exists)"
$SEALED chain gen --id "$ID" --chunks 1
BENCH=$(PDA benchmark "$ID")
echo "benchmark PDA: $BENCH"
# gen waits for the mint callback then writes the rendered bank file —
# if it never lands (RPC dead mid-run) don't burn real-model retries.
for i in $(seq 1 24); do
  [ -f "packages/harness/bank/gen-$ID.json" ] && break
  sleep 5
done
[ -f "packages/harness/bank/gen-$ID.json" ] || {
  echo "gen-$ID.json never landed — is the validator up?"; exit 1; }

say "3/6 leg A: real model ($MODEL) answers the sealed exam; leg B: mock/oracle-0.40 baseline"
ART_A=/tmp/duel-real-A.json
LEG_A_LABEL="$MODEL (real endpoint)"
# The anonymous Pollinations tier now credit-walls most calls — give the
# real endpoint a bounded shot, then degrade to a mock leg so the duel
# still proves the on-chain mechanics. Set SEALED_API_BASE/SEALED_API_KEY
# to a keyed OpenAI-compatible endpoint for the full real-model artifact.
for i in $(seq 1 5); do
  echo "--- real-model attempt $i $(date -u +%T)"
  if $SEALED run --bank "bank/gen-$ID.json" --model "$MODEL" \
      --concurrency 1 --max-tokens 512 --retries 8 --out "$ART_A" 2>&1 | tail -4; then
    if [ -f "$ART_A" ] && python3 - "$ART_A" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
print("itemsRoot", d.get("itemsRoot"), "localCorrect", d.get("localCorrect"))
sys.exit(0 if d.get("localCorrect", 0) > 0 else 1)
PY
    then break; fi
  fi
  rm -f "$ART_A"
  sleep 15
done
if [ ! -f "$ART_A" ]; then
  echo "!!! real endpoint walled after 5 attempts — leg A degrades to"
  echo "!!! mock/oracle-0.65 (mechanics still live; rerun with a keyed"
  echo "!!! SEALED_API_BASE/SEALED_API_KEY for the real-model artifact)"
  MODEL="mock/oracle-0.65"
  LEG_A_LABEL="mock/oracle-0.65 (DEGRADED — real endpoint unreachable)"
  $SEALED run --bank "bank/gen-$ID.json" --model "$MODEL" --out "$ART_A"
fi
$SEALED chain score --bank "bank/gen-$ID.json" --run "$ART_A" --create-only

JUDGE=$(node -e 'const {Keypair}=require("@solana/web3.js");const k=Keypair.generate();require("fs").writeFileSync("/tmp/duel-judge-kp.json",JSON.stringify([...k.secretKey]));console.log(k.publicKey.toBase58())')
solana airdrop 1 "$JUDGE" --url "$ANCHOR_PROVIDER_URL" >/dev/null 2>&1 || true
# The baseline leg runs from a DIFFERENT wallet — a duel between two runs
# sharing one runner is rejected on-chain (the runner could trade on it).
ANCHOR_WALLET=/tmp/duel-judge-kp.json $SEALED run \
  --bank "bank/gen-$ID.json" --model mock/oracle-0.40 --out /tmp/duel-real-B.json
ANCHOR_WALLET=/tmp/duel-judge-kp.json $SEALED chain score \
  --bank "bank/gen-$ID.json" --run /tmp/duel-real-B.json --create-only \
  --authority "$(solana address)"

RUN0=$(PDA run "$BENCH" 0)
RUN1=$(PDA run "$BENCH" 1)
echo "run PDAs: A=$RUN0 ($LEG_A_LABEL) vs B=$RUN1 (mock/oracle-0.40) — both PENDING"

say "4/6 open the duel while both runs are pending + back both sides"
$SEALED chain market duel --run-a "$RUN0" --run-b "$RUN1" --resolve-by +86400
DUEL=$(PDA duel "$RUN0" "$RUN1" 0)
echo "duel PDA: $DUEL"
# Outcomes: 0 = A outscores B, 1 = B outscores A, 2 = tie (explicit bucket).
$SEALED chain market bet --market "$DUEL" --outcome 0 --lamports 200000000
$SEALED chain market bet --market "$DUEL" --outcome 2 --lamports 50000000
$SEALED chain market bet --market "$DUEL" --outcome 1 --lamports 150000000 --bettor /tmp/duel-judge-kp.json

say "5/6 score BOTH legs through MPC — every answer hash-compared against the sealed key"
$SEALED chain score --bank "bank/gen-$ID.json" --run "$ART_A" --run-index 0
ANCHOR_WALLET=/tmp/duel-judge-kp.json $SEALED chain score \
  --bank "bank/gen-$ID.json" --run /tmp/duel-real-B.json --run-index 1 \
  --authority "$(solana address)"

say "6/6 resolve the duel straight from Run.correct + settle the pot"
$SEALED chain market resolve --market "$DUEL"
$SEALED chain market claim --market "$DUEL" || true
ANCHOR_WALLET=/tmp/duel-judge-kp.json $SEALED chain market claim --market "$DUEL" || true
$SEALED chain market show --market "$DUEL"
$SEALED chain status --benchmark "$BENCH"

echo
echo "proof summary:"
echo "  bank   $BENCH — MPC-minted; no answer key ever existed"
echo "  duel   $DUEL — opened + filled on PENDING runs, settled on MPC scores"
echo "  leg A  $RUN0 — $LEG_A_LABEL"
echo "  leg B  $RUN1 — mock/oracle-0.40 (published baseline)"
