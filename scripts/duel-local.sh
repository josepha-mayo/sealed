#!/usr/bin/env bash
# Two-real-model duel: two locally-served open-weights models answer the same
# MPC-minted exam, each from its own runner wallet, and the duel market opens
# + fills while BOTH runs are still pending — nobody trades on a score that
# doesn't exist yet. The market settles permissionlessly from the
# MPC-written counts.
#
# Chain-of-custody: bank specs+answers born inside MPC (no plaintext key
# exists) -> both artifacts commit outputs_root before scoring -> the
# market resolves on Run.correct written by the score_chunk callback.
#
# Requires: localnet up + MXE live, plus two OpenAI-compatible endpoints.
# Defaults are two llama-server instances:
#   llama-server -m qwen2.5-1.5b-instruct-q4_k_m.gguf --port 8081
#   llama-server -m qwen2.5-0.5b-instruct-q4_k_m.gguf --port 8082
# Override MODEL_A/MODEL_B + SEALED_API_BASE_A/B for any endpoints.
# Usage: scripts/duel-local.sh [bank-id-seed]
set -uo pipefail
cd "$(dirname "$0")/.."
command -v solana >/dev/null 2>&1 || \
  export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
export ARCIUM_CLUSTER_OFFSET=0
export ANCHOR_PROVIDER_URL="${ANCHOR_PROVIDER_URL:-http://127.0.0.1:8899}"
export ANCHOR_WALLET="${ANCHOR_WALLET:-$HOME/.config/solana/id.json}"
SEALED="yarn --cwd packages/harness --silent tsx src/cli.ts"
MODEL_A="${MODEL_A:-qwen2.5-1.5b-instruct}"
MODEL_B="${MODEL_B:-qwen2.5-0.5b-instruct}"
BASE_A="${SEALED_API_BASE_A:-http://127.0.0.1:8081/v1}"
BASE_B="${SEALED_API_BASE_B:-http://127.0.0.1:8082/v1}"
KEY="${SEALED_API_KEY:-local}"
SEED="${1:-duel-local-$(date +%s)}"
ID=$(node -e "console.log(require('crypto').createHash('sha256').update('duel2/' + process.argv[1]).digest().readUInt32LE(0) % 100000)" "$SEED")

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

say "0/6 endpoint sanity — both model endpoints must answer before we mint"
for leg in A B; do
  if [ "$leg" = A ]; then BURL="$BASE_A"; M="$MODEL_A"; else BURL="$BASE_B"; M="$MODEL_B"; fi
  CODE=$(curl -s -o /tmp/duel-ep-$leg.json -w "%{http_code}" --max-time 60 \
    "$BURL/chat/completions" -H "content-type: application/json" \
    -d "{\"model\":\"$M\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply with only the integer. What is 2+3? ANSWER:\"}],\"max_tokens\":16,\"temperature\":0}")
  echo "  leg $leg: $BURL model=$M -> HTTP $CODE: $(head -c 120 /tmp/duel-ep-$leg.json 2>/dev/null)"
  [ "$CODE" = 200 ] || { echo "endpoint for leg $leg is not answering — start the model server first"; exit 1; }
done

say "1/6 wait for MXE, then comp defs + circuits (once per deployment)"
scripts/wait-mxe.sh
$SEALED chain init

say "2/6 mint the exam INSIDE MPC (id=$ID, 32 items — no answer key exists)"
$SEALED chain gen --id "$ID" --chunks 1
BENCH=$(PDA benchmark "$ID")
echo "benchmark PDA: $BENCH"
for i in $(seq 1 24); do
  [ -f "packages/harness/bank/gen-$ID.json" ] && break
  sleep 5
done
[ -f "packages/harness/bank/gen-$ID.json" ] || {
  echo "gen-$ID.json never landed — is the validator up?"; exit 1; }

say "3/6 leg A: $MODEL_A vs leg B: $MODEL_B — two real models, two runner wallets"
ART_A=/tmp/duel-local-A.json
SEALED_API_BASE="$BASE_A" SEALED_API_KEY="$KEY" \
  $SEALED run --bank "bank/gen-$ID.json" --model "$MODEL_A" \
  --concurrency 1 --max-tokens 256 --retries 8 --out "$ART_A" || exit 1
python3 - "$ART_A" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
print("leg A localCorrect:", d.get("localCorrect"), "/", d.get("itemCount"))
PY

$SEALED chain score --bank "bank/gen-$ID.json" --run "$ART_A" --create-only

RUNNER_B=$(node -e 'const {Keypair}=require("@solana/web3.js");const k=Keypair.generate();require("fs").writeFileSync("/tmp/duel-runner-b-kp.json",JSON.stringify([...k.secretKey]));console.log(k.publicKey.toBase58())')
solana airdrop 1 "$RUNNER_B" --url "$ANCHOR_PROVIDER_URL" >/dev/null 2>&1 || true
# Leg B from a DIFFERENT wallet — a duel between two runs sharing one runner
# is rejected on-chain (the runner could trade on its own knowledge).
ART_B=/tmp/duel-local-B.json
SEALED_API_BASE="$BASE_B" SEALED_API_KEY="$KEY" ANCHOR_WALLET=/tmp/duel-runner-b-kp.json \
  $SEALED run --bank "bank/gen-$ID.json" --model "$MODEL_B" \
  --concurrency 1 --max-tokens 256 --retries 8 --out "$ART_B" || exit 1
python3 - "$ART_B" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
print("leg B localCorrect:", d.get("localCorrect"), "/", d.get("itemCount"))
PY
ANCHOR_WALLET=/tmp/duel-runner-b-kp.json $SEALED chain score \
  --bank "bank/gen-$ID.json" --run "$ART_B" --create-only \
  --authority "$(solana address)"

RUN0=$(PDA run "$BENCH" 0)
RUN1=$(PDA run "$BENCH" 1)
echo "run PDAs: A=$RUN0 ($MODEL_A) vs B=$RUN1 ($MODEL_B) — both PENDING"

say "4/6 open the duel while both runs are pending + back both sides"
$SEALED chain market duel --run-a "$RUN0" --run-b "$RUN1" --resolve-by +86400
DUEL=$(PDA duel "$RUN0" "$RUN1" 0)
echo "duel PDA: $DUEL"
# Outcomes: 0 = A outscores B, 1 = B outscores A, 2 = tie (explicit bucket).
$SEALED chain market bet --market "$DUEL" --outcome 0 --lamports 200000000
$SEALED chain market bet --market "$DUEL" --outcome 2 --lamports 50000000
$SEALED chain market bet --market "$DUEL" --outcome 1 --lamports 150000000 --bettor /tmp/duel-runner-b-kp.json

say "5/6 score BOTH legs through MPC — every answer hash-compared against the sealed key"
$SEALED chain score --bank "bank/gen-$ID.json" --run "$ART_A" --run-index 0
ANCHOR_WALLET=/tmp/duel-runner-b-kp.json $SEALED chain score \
  --bank "bank/gen-$ID.json" --run "$ART_B" --run-index 1 \
  --authority "$(solana address)"

say "6/6 resolve the duel straight from Run.correct + settle the pot"
$SEALED chain market resolve --market "$DUEL"
$SEALED chain market claim --market "$DUEL" || true
ANCHOR_WALLET=/tmp/duel-runner-b-kp.json $SEALED chain market claim --market "$DUEL" || true
$SEALED chain market show --market "$DUEL"
$SEALED chain status --benchmark "$BENCH"

echo
echo "proof summary:"
echo "  bank   $BENCH — MPC-minted; no answer key ever existed"
echo "  duel   $DUEL — opened + filled on PENDING runs, settled on MPC scores"
echo "  leg A  $RUN0 — $MODEL_A @ $BASE_A"
echo "  leg B  $RUN1 — $MODEL_B @ $BASE_B"
