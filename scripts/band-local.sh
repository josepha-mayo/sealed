#!/usr/bin/env bash
# Score-band market on a real model's pending run of a PRIVATE bank —
# completes the coverage matrix: every market type × real model × MPC score.
# Reuses a delegate's grant-rebuilt bank file (from real-unseen-run.sh or
# dark-local.sh) so no new private mint is needed.
#
# Usage: scripts/band-local.sh <benchmark-pda> <bank-json> <model> <endpoint>
#   e.g.  scripts/band-local.sh <pda> /tmp/dark-delegate-bank.json qwen2.5-1.5b-instruct http://127.0.0.1:8081/v1
# The runner is the delegate wallet in /tmp/dark-delegate.json when present.
set -uo pipefail
cd "$(dirname "$0")/.."
command -v solana >/dev/null 2>&1 || \
  export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
export ARCIUM_CLUSTER_OFFSET=0
export ANCHOR_PROVIDER_URL="${ANCHOR_PROVIDER_URL:-http://127.0.0.1:8899}"
export ANCHOR_WALLET="${ANCHOR_WALLET:-$HOME/.config/solana/id.json}"
SEALED="yarn --cwd packages/harness --silent tsx src/cli.ts"
PBENCH="${1:?usage: band-local.sh <benchmark-pda> <bank-json> <model> <endpoint>}"
DBANK="${2:?bank-json required}"
MODEL="${3:?model name required}"
BASE="${4:?endpoint base required}"
WALLET="${BAND_WALLET:-/tmp/dark-delegate.json}"
[ -f "$WALLET" ] || WALLET="$ANCHOR_WALLET"

say() { printf '\n=== %s ===\n' "$*"; }
RUNPDA() {
  node - "$1" "$2" <<'EOF'
const { PublicKey } = require("@solana/web3.js");
const SEALED = new PublicKey("FGVuEoWpDGTqBBuR9e26t2t5mDngXgbrAj5CtuLKXLUZ");
const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(process.argv[3]));
console.log(PublicKey.findProgramAddressSync([Buffer.from("run"), new PublicKey(process.argv[2]).toBuffer(), b], SEALED)[0].toBase58());
EOF
}
BANDPDA() {
  node - "$1" "$2" <<'EOF'
const { PublicKey } = require("@solana/web3.js");
const MARKET = new PublicKey("8VSHkhNLN3q3yBUhYmTjgKSCMA55VFzfLPXcgp4Z91vN");
const le = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
console.log(PublicKey.findProgramAddressSync([Buffer.from("market"), new PublicKey(process.argv[2]).toBuffer(), le(process.argv[3])], MARKET)[0].toBase58());
EOF
}

say "0/5 endpoint sanity — $MODEL"
CODE=$(curl -s -o /tmp/band-ep.json -w "%{http_code}" --max-time 90 \
  "$BASE/chat/completions" -H "content-type: application/json" \
  -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply with only the integer. What is 2+3? ANSWER:\"}],\"max_tokens\":16,\"temperature\":0}")
echo "  $BASE model=$MODEL -> HTTP $CODE"
[ "$CODE" = 200 ] || { echo "endpoint not answering"; exit 1; }

say "1/5 $MODEL answers the private exam (accessed only via grants)"
ART=/tmp/band-run.json
SEALED_API_BASE="$BASE" SEALED_API_KEY=local ANCHOR_WALLET="$WALLET" \
  $SEALED run --bank "$DBANK" --model "$MODEL" \
  --concurrency 1 --max-tokens 256 --retries 8 --out "$ART" || exit 1
python3 - "$ART" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
print("localCorrect:", d.get("localCorrect"), "/", d.get("itemCount"))
PY

say "2/5 create the run PENDING, then open a score-band market on it"
AUTHORITY=$(solana address)
RUNIDX=$($SEALED chain status --benchmark "$PBENCH" | grep -oP '(?<=runs=)[0-9]+')
ANCHOR_WALLET="$WALLET" $SEALED chain score \
  --bank "$DBANK" --run "$ART" --create-only --authority "$AUTHORITY"
RUN=$(RUNPDA "$PBENCH" "$RUNIDX")
echo "pending run PDA: $RUN (index $RUNIDX)"
BSALT=$(( ( RANDOM % 900 ) + 1 ))
$SEALED chain market open --run "$RUN" --salt "$BSALT" \
  --edges "1,8,16,24,32" --resolve-by +86400
BAND=$(BANDPDA "$RUN" "$BSALT")
echo "band market PDA: $BAND (bands 0 | 1–8 | 9–16 | 17–24 | 25–32)"

say "3/5 two backers disagree — every bucket must be backed or the market cancels"
# Seed the long-shot buckets with dust so the book is complete; the real
# disagreement is 1–7 (authority) vs 8–15 (delegate).
for o in 0 3 4 5; do
  $SEALED chain market bet --market "$BAND" --outcome "$o" --lamports 5000000
done
$SEALED chain market bet --market "$BAND" --outcome 1 --lamports 100000000
ANCHOR_WALLET="$WALLET" $SEALED chain market bet --market "$BAND" \
  --outcome 2 --lamports 60000000 --bettor "$WALLET"

say "4/5 MPC scores the run → permissionless resolve"
ANCHOR_WALLET="$WALLET" $SEALED chain score \
  --bank "$DBANK" --run "$ART" --run-index "$RUNIDX" --authority "$AUTHORITY"
$SEALED chain market resolve --market "$BAND"
$SEALED chain market show --market "$BAND"

say "5/5 winners claim"
$SEALED chain market claim --market "$BAND" --outcome 1 || true
ANCHOR_WALLET="$WALLET" $SEALED chain market claim --market "$BAND" \
  --outcome 2 --bettor "$WALLET" || true
$SEALED chain status --benchmark "$PBENCH"

echo
echo "proof summary:"
echo "  bank  $PBENCH — private, ciphertext-only"
echo "  band  $BAND — score-band market settled on the MPC-written score"
echo "  run   $RUN — $MODEL (index $RUNIDX)"
