#!/usr/bin/env bash
# Capability-registry demo: a real open-weights model answers an MPC-minted
# exam (no answer key exists anywhere), gets scored inside the cluster, and
# its finalized run is enrolled into the persistent ModelRecord PDA — then
# `chain modelrec` prints the aggregate and a second enrollment attempt fails
# on the init-once ScoreLog receipt.
#
# Chain-of-custody: specs+answers born inside MPC -> artifact commits
# outputs_root before scoring -> Run.correct written by the score_chunk
# callback -> record_score folds the PROVEN score (not a self-report) into
# the registry. Enrollment is permissionless; attestation stays separate.
#
# Requires: localnet up + MXE live, one OpenAI-compatible endpoint.
# Default is a llama-server leg:
#   llama-server -m qwen2.5-1.5b-instruct-q4_k_m.gguf --port 8081
# Override MODEL / SEALED_API_BASE for any endpoint.
# Usage: scripts/record-local.sh [bank-id-seed]
set -uo pipefail
cd "$(dirname "$0")/.."
command -v solana >/dev/null 2>&1 || \
  export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
export ARCIUM_CLUSTER_OFFSET=0
export ANCHOR_PROVIDER_URL="${ANCHOR_PROVIDER_URL:-http://127.0.0.1:8899}"
export ANCHOR_WALLET="${ANCHOR_WALLET:-$HOME/.config/solana/id.json}"
SEALED="yarn --cwd packages/harness --silent tsx src/cli.ts"
MODEL="${MODEL:-qwen2.5-1.5b-instruct}"
BASE="${SEALED_API_BASE:-http://127.0.0.1:8081/v1}"
KEY="${SEALED_API_KEY:-local}"
SEED="${1:-record-local-$(date +%s)}"
ID=$(node -e "console.log(require('crypto').createHash('sha256').update('recreg/' + process.argv[1]).digest().readUInt32LE(0) % 100000)" "$SEED")

say() { printf '\n=== %s ===\n' "$*"; }

PDA() { # PDA <benchmark|run> <args...>
  node - "$@" <<'EOF'
const { PublicKey, Keypair } = require("@solana/web3.js");
const { readFileSync } = require("fs");
const { homedir } = require("os");
const SEALED = new PublicKey("FGVuEoWpDGTqBBuR9e26t2t5mDngXgbrAj5CtuLKXLUZ");
const le = (n, w) => { const b = Buffer.alloc(w); w === 4 ? b.writeUInt32LE(Number(n)) : b.writeBigUInt64LE(BigInt(n)); return b; };
const wallet = () => Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(process.env.ANCHOR_WALLET ?? `${homedir()}/.config/solana/id.json`, "utf8")))).publicKey;
const [kind, a, i] = process.argv.slice(2);
const pda = kind === "benchmark"
  ? PublicKey.findProgramAddressSync([Buffer.from("benchmark"), wallet().toBuffer(), le(a, 4)], SEALED)
  : PublicKey.findProgramAddressSync([Buffer.from("run"), new PublicKey(a).toBuffer(), le(i ?? 0, 8)], SEALED);
console.log(pda[0].toBase58());
EOF
}

say "0/5 endpoint sanity — the model must answer before we mint"
CODE=$(curl -s -o /tmp/record-ep.json -w "%{http_code}" --max-time 60 \
  "$BASE/chat/completions" -H "content-type: application/json" \
  -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply with only the integer. What is 2+3? ANSWER:\"}],\"max_tokens\":16,\"temperature\":0}")
echo "  $BASE model=$MODEL -> HTTP $CODE: $(head -c 120 /tmp/record-ep.json 2>/dev/null)"
[ "$CODE" = 200 ] || { echo "endpoint not answering — start the model server first"; exit 1; }

say "1/5 wait for MXE, then comp defs + circuits (once per deployment)"
scripts/wait-mxe.sh
$SEALED chain init

say "2/5 mint the exam INSIDE MPC (id=$ID, 32 items — no answer key exists)"
$SEALED chain gen --id "$ID" --chunks 1
BENCH=$(PDA benchmark "$ID")
echo "benchmark PDA: $BENCH"
for i in $(seq 1 24); do
  [ -f "packages/harness/bank/gen-$ID.json" ] && break
  sleep 5
done
[ -f "packages/harness/bank/gen-$ID.json" ] || {
  echo "gen-$ID.json never landed — is the validator up?"; exit 1; }

say "3/5 $MODEL answers the exam — artifact commits outputs_root pre-scoring"
ART=/tmp/record-local.json
SEALED_API_BASE="$BASE" SEALED_API_KEY="$KEY" \
  $SEALED run --bank "bank/gen-$ID.json" --model "$MODEL" \
  --concurrency 1 --max-tokens 256 --retries 8 --out "$ART" || exit 1
python3 - "$ART" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
print("localCorrect:", d.get("localCorrect"), "/", d.get("itemCount"))
PY

say "4/5 score through MPC — the cluster writes Run.correct, not us"
$SEALED chain score --bank "bank/gen-$ID.json" --run "$ART"
RUN=$(PDA run "$BENCH" 0)
echo "run PDA: $RUN"

say "5/5 enroll the proven score into the capability registry"
$SEALED chain record --run "$RUN"
$SEALED chain modelrec "$MODEL"
echo
echo "double-enrollment is structurally impossible — ScoreLog [scorelog, run]"
echo "was created by init; a second record_score re-derives the same PDA and"
echo "the system program refuses to create it twice:"
$SEALED chain record --run "$RUN" || echo "  (rejected — expected)"

echo
echo "proof summary:"
echo "  bank   $BENCH — MPC-minted; no answer key ever existed"
echo "  run    $RUN — $MODEL @ $BASE"
echo "  record modelrec PDA [modelrec, sha256('$MODEL')] — persistent aggregate"
