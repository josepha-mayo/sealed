#!/usr/bin/env bash
# Private-bank duel: TWO delegates, each seeing the exam only through their
# own MPC reshare grants, race different real models on the same
# ciphertext-only bank — and a head-to-head market prices the blind race.
# The strongest composition in the repo: unseen exam × runner-vs-runner.
#
# Usage: scripts/duel-private.sh <private-benchmark-pda>
#   Reuses /tmp/dark-delegate.json as delegate A when present (it already
#   holds grants on dark-local.sh's bank); mints a fresh delegate B.
#   Defaults: A=qwen2.5-3b :8083, B=qwen2.5-1.5b :8081.
set -uo pipefail
cd "$(dirname "$0")/.."
command -v solana >/dev/null 2>&1 || \
  export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
export ARCIUM_CLUSTER_OFFSET=0
export ANCHOR_PROVIDER_URL="${ANCHOR_PROVIDER_URL:-http://127.0.0.1:8899}"
export ANCHOR_WALLET="${ANCHOR_WALLET:-$HOME/.config/solana/id.json}"
SEALED="yarn --cwd packages/harness --silent tsx src/cli.ts"
PBENCH="${1:?usage: duel-private.sh <private-benchmark-pda>}"
MODEL_A="${MODEL_A:-qwen2.5-3b-instruct}"
MODEL_B="${MODEL_B:-qwen2.5-1.5b-instruct}"
BASE_A="${BASE_A:-http://127.0.0.1:8083/v1}"
BASE_B="${BASE_B:-http://127.0.0.1:8081/v1}"
WAL_A="${DELEGATE_A:-/tmp/dark-delegate.json}"
WAL_B=/tmp/duel-priv-b-kp.json
AUTHORITY=$(solana address)

say() { printf '\n=== %s ===\n' "$*"; }
RUNPDA() {
  node - "$1" "$2" <<'EOF'
const { PublicKey } = require("@solana/web3.js");
const SEALED = new PublicKey("FGVuEoWpDGTqBBuR9e26t2t5mDngXgbrAj5CtuLKXLUZ");
const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(process.argv[3]));
console.log(PublicKey.findProgramAddressSync([Buffer.from("run"), new PublicKey(process.argv[2]).toBuffer(), b], SEALED)[0].toBase58());
EOF
}
DUELPDA() {
  node - "$1" "$2" <<'EOF'
const { PublicKey } = require("@solana/web3.js");
const MARKET = new PublicKey("8VSHkhNLN3q3yBUhYmTjgKSCMA55VFzfLPXcgp4Z91vN");
const le = Buffer.alloc(8);
console.log(PublicKey.findProgramAddressSync([Buffer.from("duel"), new PublicKey(process.argv[2]).toBuffer(), new PublicKey(process.argv[3]).toBuffer(), le], MARKET)[0].toBase58());
EOF
}

say "0/7 endpoint sanity — both legs must answer before anything is minted"
for leg in A B; do
  M=$(eval echo \$MODEL_$leg); U=$(eval echo \$BASE_$leg)
  CODE=$(curl -s -o /tmp/duelp-ep-$leg.json -w "%{http_code}" --max-time 90 \
    "$U/chat/completions" -H "content-type: application/json" \
    -d "{\"model\":\"$M\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply with only the integer. What is 2+3? ANSWER:\"}],\"max_tokens\":16,\"temperature\":0}")
  echo "  leg $leg: $U model=$M -> HTTP $CODE"
  [ "$CODE" = 200 ] || { echo "endpoint $leg dead"; exit 1; }
done

say "1/7 grant delegate B every part of chunk 0 (delegate A already holds grants)"
B_PUB=$(node -e 'const {Keypair}=require("@solana/web3.js");const k=Keypair.generate();require("fs").writeFileSync("/tmp/duel-priv-b-kp.json",JSON.stringify([...k.secretKey]));console.log(k.publicKey.toBase58())')
solana airdrop 1 "$B_PUB" --url "$ANCHOR_PROVIDER_URL" >/dev/null 2>&1 || true
for p in 0 1 2 3; do $SEALED chain reshare --benchmark "$PBENCH" --chunk 0 --part "$p" --to "$B_PUB"; sleep 2; done
$SEALED chain grants --benchmark "$PBENCH" | tail -10

say "2/7 each delegate rebuilds the bank from ITS OWN grants alone"
DBANK_A=/tmp/duel-priv-bank-a.json
DBANK_B=/tmp/duel-priv-bank-b.json
ANCHOR_WALLET="$WAL_A" $SEALED chain delegate-bank --benchmark "$PBENCH" --out "$DBANK_A"
ANCHOR_WALLET="$WAL_B" $SEALED chain delegate-bank --benchmark "$PBENCH" --out "$DBANK_B"
# sanity: both rebuilt files must bind the same items_root
python3 - "$DBANK_A" "$DBANK_B" <<'PY'
import json, sys
a, b = json.load(open(sys.argv[1])), json.load(open(sys.argv[2]))
ra, rb = a.get("itemsRoot"), b.get("itemsRoot")
print("A itemsRoot:", ra)
print("B itemsRoot:", rb)
assert ra == rb, "delegates disagree on the exam — bug"
print("both delegates reconstructed the SAME exam — grants are consistent")
PY

say "3/7 both delegates answer in PARALLEL — same hidden exam, different models"
ART_A=/tmp/duel-priv-art-a.json
ART_B=/tmp/duel-priv-art-b.json
SEALED_API_BASE="$BASE_A" SEALED_API_KEY=local ANCHOR_WALLET="$WAL_A" \
  $SEALED run --bank "$DBANK_A" --model "$MODEL_A" \
  --concurrency 1 --max-tokens 256 --retries 8 --out "$ART_A" &
PID_A=$!
SEALED_API_BASE="$BASE_B" SEALED_API_KEY=local ANCHOR_WALLET="$WAL_B" \
  $SEALED run --bank "$DBANK_B" --model "$MODEL_B" \
  --concurrency 1 --max-tokens 256 --retries 8 --out "$ART_B" &
PID_B=$!
wait $PID_A; RA=$?; wait $PID_B; RB=$?
[ $RA -eq 0 ] && [ $RB -eq 0 ] || { echo "a leg failed to produce an artifact"; exit 1; }
python3 - "$ART_A" "$ART_B" <<'PY'
import json, sys
for f in sys.argv[1:]:
    d = json.load(open(f))
    print(d.get("modelId"), "localCorrect:", d.get("localCorrect"), "/", d.get("itemCount"))
PY

say "4/7 both runs created PENDING + duel market opens and fills blind"
RUNIDX=$($SEALED chain status --benchmark "$PBENCH" | grep -oP '(?<=runs=)[0-9]+')
IDX_A=$RUNIDX; IDX_B=$((RUNIDX + 1))
ANCHOR_WALLET="$WAL_A" $SEALED chain score --bank "$DBANK_A" --run "$ART_A" \
  --create-only --authority "$AUTHORITY"
ANCHOR_WALLET="$WAL_B" $SEALED chain score --bank "$DBANK_B" --run "$ART_B" \
  --create-only --authority "$AUTHORITY"
RUN_A=$(RUNPDA "$PBENCH" "$IDX_A")
RUN_B=$(RUNPDA "$PBENCH" "$IDX_B")
echo "run A: $RUN_A (#$IDX_A, $MODEL_A) — run B: $RUN_B (#$IDX_B, $MODEL_B)"
# hard gate: both PDAs must exist before the market opens on them
node - "$RUN_A" "$RUN_B" <<'EOF'
const { Connection, PublicKey } = require("@solana/web3.js");
const c = new Connection(process.env.ANCHOR_PROVIDER_URL ?? "http://127.0.0.1:8899", "confirmed");
(async () => {
  for (const pk of [process.argv[2], process.argv[3]]) {
    const i = await c.getAccountInfo(new PublicKey(pk));
    if (!i) { console.error(`FATAL: run ${pk} does not exist — aborting before market open`); process.exit(1); }
  }
  console.log("both run PDAs confirmed on-chain");
})().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
EOF
[ $? -eq 0 ] || exit 1
$SEALED chain market duel --run-a "$RUN_A" --run-b "$RUN_B" --resolve-by +86400
DUEL=$(DUELPDA "$RUN_A" "$RUN_B")
echo "duel PDA: $DUEL — three-way book: A wins | B wins | tie"
# duel needs every bucket backed to resolve (same all_backed rule).
$SEALED chain market bet --market "$DUEL" --outcome 0 --lamports 150000000
$SEALED chain market bet --market "$DUEL" --outcome 2 --lamports 40000000
ANCHOR_WALLET="$WAL_B" $SEALED chain market bet --market "$DUEL" --outcome 1 \
  --lamports 100000000 --bettor "$WAL_B"

say "5/7 score BOTH runs through MPC — the answer key never left the enclave"
ANCHOR_WALLET="$WAL_A" $SEALED chain score --bank "$DBANK_A" --run "$ART_A" \
  --run-index "$IDX_A" --authority "$AUTHORITY"
ANCHOR_WALLET="$WAL_B" $SEALED chain score --bank "$DBANK_B" --run "$ART_B" \
  --run-index "$IDX_B" --authority "$AUTHORITY"

say "6/7 resolve the blind duel straight from Run.correct"
$SEALED chain market resolve --market "$DUEL"
$SEALED chain market show --market "$DUEL"

say "7/7 winners claim"
$SEALED chain market claim --market "$DUEL" || true
ANCHOR_WALLET="$WAL_B" $SEALED chain market claim --market "$DUEL" --bettor "$WAL_B" || true
$SEALED chain status --benchmark "$PBENCH"

echo
echo "proof summary:"
echo "  bank  $PBENCH — private; ciphertext-only specs; two delegates saw it via grants"
echo "  duel  $DUEL — blind head-to-head settled on MPC scores"
echo "  A     $RUN_A — $MODEL_A"
echo "  B     $RUN_B — $MODEL_B"
