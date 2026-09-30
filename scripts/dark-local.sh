#!/usr/bin/env bash
# The purest privacy composition: a DARK commit-reveal market on a PRIVATE
# bank's pending real-model run. The exam's questions exist only as
# ciphertext; the delegate sees them only through MPC reshare grants; and
# every bettor's side is a sha256 commitment until they choose to reveal.
# Exam sealed + positions sealed + score written by MPC.
#
# Requires: localnet + MXE live + one OpenAI-compatible model endpoint
# (default: local llama.cpp qwen2.5-3b on :8083 — see serve-local.sh).
# Usage: scripts/dark-local.sh [benchmark-pda]
#   With no arg, mints a fresh private bank inside MPC first.
set -uo pipefail
cd "$(dirname "$0")/.."
command -v solana >/dev/null 2>&1 || \
  export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
export ARCIUM_CLUSTER_OFFSET=0
export ANCHOR_PROVIDER_URL="${ANCHOR_PROVIDER_URL:-http://127.0.0.1:8899}"
export ANCHOR_WALLET="${ANCHOR_WALLET:-$HOME/.config/solana/id.json}"
SEALED="yarn --cwd packages/harness --silent tsx src/cli.ts"
MODEL="${MODEL:-qwen2.5-3b-instruct}"
BASE="${SEALED_API_BASE:-http://127.0.0.1:8083/v1}"
KEY="${SEALED_API_KEY:-local}"
THRESH="${DARK_THRESHOLD:-5}"

say() { printf '\n=== %s ===\n' "$*"; }

DARKPDA() { # DARKPDA <run> <salt>
  node - "$1" "$2" <<'EOF'
const { PublicKey } = require("@solana/web3.js");
const MARKET = new PublicKey("8VSHkhNLN3q3yBUhYmTjgKSCMA55VFzfLPXcgp4Z91vN");
const le = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
console.log(PublicKey.findProgramAddressSync([Buffer.from("dark"), new PublicKey(process.argv[2]).toBuffer(), le(process.argv[3])], MARKET)[0].toBase58());
EOF
}
RUNPDA() { # RUNPDA <bench> <idx>
  node - "$1" "$2" <<'EOF'
const { PublicKey } = require("@solana/web3.js");
const SEALED = new PublicKey("FGVuEoWpDGTqBBuR9e26t2t5mDngXgbrAj5CtuLKXLUZ");
const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(process.argv[3]));
console.log(PublicKey.findProgramAddressSync([Buffer.from("run"), new PublicKey(process.argv[2]).toBuffer(), b], SEALED)[0].toBase58());
EOF
}

say "0/6 endpoint sanity — $MODEL must answer before we mint"
CODE=$(curl -s -o /tmp/dark-ep.json -w "%{http_code}" --max-time 90 \
  "$BASE/chat/completions" -H "content-type: application/json" \
  -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply with only the integer. What is 2+3? ANSWER:\"}],\"max_tokens\":16,\"temperature\":0}")
echo "  $BASE model=$MODEL -> HTTP $CODE: $(head -c 100 /tmp/dark-ep.json 2>/dev/null)"
[ "$CODE" = 200 ] || { echo "endpoint not answering — start the model server"; exit 1; }

if [ -n "${1:-}" ]; then
  PBENCH="$1"
  echo "using existing private bank $PBENCH"
else
  say "1/6 mint a PRIVATE bank inside MPC — specs ciphertext-only on chain"
  ID=$(( ( RANDOM % 90000 ) + 10000 ))
  $SEALED chain gen-private --id "$ID" --chunks 1
  PBENCH=$(node - "$ID" <<'EOF'
const { PublicKey, Keypair } = require("@solana/web3.js");
const { readFileSync } = require("fs");
const { homedir } = require("os");
const SEALED = new PublicKey("FGVuEoWpDGTqBBuR9e26t2t5mDngXgbrAj5CtuLKXLUZ");
const kp = Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(process.env.ANCHOR_WALLET ?? `${homedir()}/.config/solana/id.json`, "utf8"))));
const b = Buffer.alloc(4); b.writeUInt32LE(Number(process.argv[2]));
console.log(PublicKey.findProgramAddressSync([Buffer.from("benchmark"), kp.publicKey.toBuffer(), b], SEALED)[0].toBase58());
EOF
)
  echo "private benchmark PDA: $PBENCH"
fi

say "2/6 reshare all 4 parts of chunk 0 to a fresh delegate inside MPC"
DELEGATE=$(node -e 'const {Keypair}=require("@solana/web3.js");const k=Keypair.generate();require("fs").writeFileSync("/tmp/dark-delegate.json",JSON.stringify([...k.secretKey]));console.log(k.publicKey.toBase58())')
solana airdrop 1 "$DELEGATE" --url "$ANCHOR_PROVIDER_URL" >/dev/null 2>&1 || true
for p in 0 1 2 3; do $SEALED chain reshare --benchmark "$PBENCH" --chunk 0 --part "$p" --to "$DELEGATE"; sleep 2; done

say "3/6 delegate rebuilds the bank from grants alone → real model answers"
DBANK=/tmp/dark-delegate-bank.json
ANCHOR_WALLET=/tmp/dark-delegate.json $SEALED chain delegate-bank --benchmark "$PBENCH" --out "$DBANK"
ART=/tmp/dark-run.json
SEALED_API_BASE="$BASE" SEALED_API_KEY="$KEY" ANCHOR_WALLET=/tmp/dark-delegate.json \
  $SEALED run --bank "$DBANK" --model "$MODEL" \
  --concurrency 1 --max-tokens 256 --retries 8 --out "$ART" || exit 1
python3 - "$ART" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
print("localCorrect:", d.get("localCorrect"), "/", d.get("itemCount"))
PY

say "4/6 create the run PENDING + open a dark market on it (positions sealed)"
AUTHORITY=$(solana address)
# run index = current run count on this bank — read it, then create-only.
RUNIDX=$($SEALED chain status --benchmark "$PBENCH" | grep -oP '(?<=runs=)[0-9]+')
ANCHOR_WALLET=/tmp/dark-delegate.json $SEALED chain score \
  --bank "$DBANK" --run "$ART" --create-only --authority "$AUTHORITY"
RUN=$(RUNPDA "$PBENCH" "$RUNIDX")
echo "pending run PDA: $RUN (index $RUNIDX on the private bank)"
DSALT=$(( ( RANDOM % 900 ) + 1 ))
$SEALED chain market dark open --run "$RUN" --salt "$DSALT" \
  --threshold "$THRESH" --resolve-by +86400 --reveal-secs 60
DARK=$(DARKPDA "$RUN" "$DSALT")
echo "dark market PDA: $DARK (sealed bets on whether $MODEL scores >= $THRESH — on an exam nobody can read)"

say "5/6 two sealed positions on opposite sides — sides never hit the wire"
BET0=$(ANCHOR_WALLET=/tmp/dark-delegate.json $SEALED chain market dark bet \
  --market "$DARK" --outcome 0 --lamports 80000000 --pos-salt 51 --bettor /tmp/dark-delegate.json)
echo "$BET0"
SALT0=$(echo "$BET0" | grep -oP '(?<=--salt )[0-9a-f]{64}')
BET1=$($SEALED chain market dark bet \
  --market "$DARK" --outcome 1 --lamports 120000000 --pos-salt 52)
echo "$BET1"
SALT1=$(echo "$BET1" | grep -oP '(?<=--salt )[0-9a-f]{64}')

say "6/6 MPC scores the run → resolve → winner reveals → loser forfeits"
ANCHOR_WALLET=/tmp/dark-delegate.json $SEALED chain score \
  --bank "$DBANK" --run "$ART" --run-index "$RUNIDX" --authority "$AUTHORITY"
RESOLVE_OUT=$($SEALED chain market dark resolve --market "$DARK")
echo "$RESOLVE_OUT"
OUTCOME=$(echo "$RESOLVE_OUT" | grep -oP '(?<=outcome )[0-9]+' | head -1)
if [ "$OUTCOME" = "0" ]; then
  ANCHOR_WALLET=/tmp/dark-delegate.json $SEALED chain market dark reveal \
    --market "$DARK" --pos-salt 51 --outcome 0 --salt "$SALT0" --bettor /tmp/dark-delegate.json || true
else
  $SEALED chain market dark reveal --market "$DARK" --pos-salt 52 \
    --outcome 1 --salt "$SALT1" || true
fi
echo "waiting out the 60s reveal window so finalize can tally…"
sleep 65
$SEALED chain market dark finalize --market "$DARK"
if [ "$OUTCOME" = "0" ]; then
  ANCHOR_WALLET=/tmp/dark-delegate.json $SEALED chain market dark claim \
    --market "$DARK" --pos-salt 51 --bettor /tmp/dark-delegate.json || true
else
  $SEALED chain market dark claim --market "$DARK" --pos-salt 52 || true
fi
$SEALED chain market dark show --market "$DARK"
$SEALED chain status --benchmark "$PBENCH"

echo
echo "proof summary:"
echo "  bank   $PBENCH — private; specs ciphertext-only on chain"
echo "  dark   $DARK — sealed positions priced a sealed exam, settled on MPC score"
echo "  run    $RUN — $MODEL (index $RUNIDX), could only read the exam via grants"
