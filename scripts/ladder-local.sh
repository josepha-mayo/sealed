#!/usr/bin/env bash
# Four-real-model ladder race: FOUR open-weights models — two families, four
# sizes — answer the same MPC-minted exam, each from its own runner wallet,
# and a K-way argmax market opens + fills while ALL legs are still pending.
# Resolution is argmax over the MPC-written Run.correct values with dead-heat
# pro-rata on ties.
#
# Why this artifact exists: the ladder is the widest market primitive (3–8
# legs). Four REAL models racing — not mocks — is the strongest possible
# demonstration that the market settles a leaderboard nobody could precompute.
#
# Requires: localnet up + MXE live + four llama-server instances
# (scripts/serve-local.sh starts them; see MODELS below to override).
# Usage: scripts/ladder-local.sh [bank-id-seed]
set -uo pipefail
cd "$(dirname "$0")/.."
command -v solana >/dev/null 2>&1 || \
  export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
export ARCIUM_CLUSTER_OFFSET=0
export ANCHOR_PROVIDER_URL="${ANCHOR_PROVIDER_URL:-http://127.0.0.1:8899}"
export ANCHOR_WALLET="${ANCHOR_WALLET:-$HOME/.config/solana/id.json}"
SEALED="yarn --cwd packages/harness --silent tsx src/cli.ts"
KEY="${SEALED_API_KEY:-local}"
SEED="${1:-ladder-local-$(date +%s)}"
ID=$(node -e "console.log(require('crypto').createHash('sha256').update('ladder4/' + process.argv[1]).digest().readUInt32LE(0) % 100000)" "$SEED")

# The race card — strongest first. Endpoints serve any OpenAI-compatible API;
# each leg MUST have a distinct runner wallet (RunnersMustDiffer).
LEG_PORTS=(8083 8081 8084 8082)
LEG_MODELS=(qwen2.5-3b-instruct qwen2.5-1.5b-instruct llama-3.2-1b-instruct qwen2.5-0.5b-instruct)
NLEGS=${#LEG_MODELS[@]}

say() { printf '\n=== %s ===\n' "$*"; }

PDA() { # PDA <market|run|benchmark|duel|ladder> <args...>
  node - "$@" <<'EOF'
const { PublicKey, Keypair } = require("@solana/web3.js");
const { readFileSync } = require("fs");
const { homedir } = require("os");
const SEALED = new PublicKey("FGVuEoWpDGTqBBuR9e26t2t5mDngXgbrAj5CtuLKXLUZ");
const MARKET = new PublicKey("8VSHkhNLN3q3yBUhYmTjgKSCMA55VFzfLPXcgp4Z91vN");
const le = (n, w) => { const b = Buffer.alloc(w); w === 4 ? b.writeUInt32LE(Number(n)) : b.writeBigUInt64LE(BigInt(n)); return b; };
const wallet = () => Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(process.env.ANCHOR_WALLET ?? `${homedir()}/.config/solana/id.json`, "utf8")))).publicKey;
const [kind, a, i] = process.argv.slice(2);
const pda = kind === "benchmark"
  ? PublicKey.findProgramAddressSync([Buffer.from("benchmark"), wallet().toBuffer(), le(a, 4)], SEALED)
  : kind === "run"
  ? PublicKey.findProgramAddressSync([Buffer.from("run"), new PublicKey(a).toBuffer(), le(i, 8)], SEALED)
  : kind === "ladder"
  ? PublicKey.findProgramAddressSync([Buffer.from("ladder"), new PublicKey(a).toBuffer(), le(i ?? 0, 8)], MARKET)
  : PublicKey.findProgramAddressSync([Buffer.from("market"), new PublicKey(a).toBuffer(), le(i ?? 0, 8)], MARKET);
console.log(pda[0].toBase58());
EOF
}

say "0/6 endpoint sanity — all $NLEGS model endpoints must answer before we mint"
for i in "${!LEG_MODELS[@]}"; do
  M="${LEG_MODELS[$i]}"; PORT="${LEG_PORTS[$i]}"
  CODE=$(curl -s -o "/tmp/lad-ep-$i.json" -w "%{http_code}" --max-time 90 \
    "http://127.0.0.1:$PORT/v1/chat/completions" -H "content-type: application/json" \
    -d "{\"model\":\"$M\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply with only the integer. What is 2+3? ANSWER:\"}],\"max_tokens\":16,\"temperature\":0}")
  echo "  leg $i: :$PORT model=$M -> HTTP $CODE: $(head -c 100 /tmp/lad-ep-$i.json 2>/dev/null)"
  [ "$CODE" = 200 ] || { echo "endpoint for leg $i is not answering — start it first (scripts/serve-local.sh)"; exit 1; }
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

say "3/6 $NLEGS real models answer — one runner wallet per leg (parallel)"
# Legs 1..N-1 get fresh runner keypairs; leg 0 uses the default wallet.
declare -a ART WAL KPUB
for i in "${!LEG_MODELS[@]}"; do
  ART[$i]="/tmp/ladder-local-$i.json"
  if [ "$i" -eq 0 ]; then
    WAL[$i]="$ANCHOR_WALLET"
  else
    WAL[$i]="/tmp/ladder-runner-$i.json"
    KPUB[$i]=$(node -e 'const {Keypair}=require("@solana/web3.js");const k=Keypair.generate();require("fs").writeFileSync(process.argv[1],JSON.stringify([...k.secretKey]));console.log(k.publicKey.toBase58())' "${WAL[$i]}")
    solana airdrop 1 "${KPUB[$i]}" --url "$ANCHOR_PROVIDER_URL" >/dev/null 2>&1 || true
  fi
done

# Answer phases run CONCURRENTLY — independent endpoints, independent wallets.
for i in "${!LEG_MODELS[@]}"; do
  SEALED_API_BASE="http://127.0.0.1:${LEG_PORTS[$i]}/v1" SEALED_API_KEY="$KEY" \
  ANCHOR_WALLET="${WAL[$i]}" \
    $SEALED run --bank "bank/gen-$ID.json" --model "${LEG_MODELS[$i]}" \
    --concurrency 1 --max-tokens 256 --retries 8 --out "${ART[$i]}" \
    >"/tmp/ladder-run-$i.log" 2>&1 &
done
wait
for i in "${!LEG_MODELS[@]}"; do
  [ -f "${ART[$i]}" ] || { echo "leg $i produced no artifact"; tail -5 "/tmp/ladder-run-$i.log"; exit 1; }
  python3 - "${ART[$i]}" "$i" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
print(f"leg {sys.argv[2]} localCorrect: {d.get('localCorrect')} / {d.get('itemCount')}")
PY
done

say "4/6 create all $NLEGS runs (pending, unscored) + open the ladder"
AUTHORITY=$(solana address)
for i in "${!LEG_MODELS[@]}"; do
  EXTRA=""
  [ "$i" -ne 0 ] && EXTRA="--authority $AUTHORITY"
  ANCHOR_WALLET="${WAL[$i]}" $SEALED chain score \
    --bank "bank/gen-$ID.json" --run "${ART[$i]}" --create-only $EXTRA
done

LEGS=""
for i in "${!LEG_MODELS[@]}"; do
  R=$(PDA run "$BENCH" "$i")
  LEGS="${LEGS:+$LEGS,}$R"
  echo "  leg $i run PDA: $R (${LEG_MODELS[$i]})"
done
FIRST_LEG="${LEGS%%,*}"
SALT=$((ID % 1000))
$SEALED chain market ladder open --legs "$LEGS" --salt "$SALT" \
  --closes-at +7200 --resolve-by +86400
LADDER=$(PDA ladder "$FIRST_LEG" "$SALT")
echo "ladder PDA: $LADDER"

say "5/6 back legs while ALL are pending — spreads across the field"
$SEALED chain market ladder bet --market "$LADDER" --outcome 0 --lamports 120000000
$SEALED chain market ladder bet --market "$LADDER" --outcome 1 --lamports 100000000 \
  --bettor "${WAL[1]}"
$SEALED chain market ladder bet --market "$LADDER" --outcome 2 --lamports 80000000 \
  --bettor "${WAL[2]}"
$SEALED chain market ladder bet --market "$LADDER" --outcome 3 --lamports 60000000 \
  --bettor "${WAL[3]}"
$SEALED chain market ladder bet --market "$LADDER" --outcome 0 --lamports 50000000 \
  --bettor "${WAL[1]}"

say "6/6 score every leg through MPC, then argmax-settle the race"
for i in "${!LEG_MODELS[@]}"; do
  EXTRA=""
  [ "$i" -ne 0 ] && EXTRA="--authority $AUTHORITY"
  ANCHOR_WALLET="${WAL[$i]}" $SEALED chain score \
    --bank "bank/gen-$ID.json" --run "${ART[$i]}" --run-index "$i" $EXTRA
done
$SEALED chain market ladder resolve --market "$LADDER"
for i in 0 1 2 3; do
  ANCHOR_WALLET="${WAL[$i]:-$ANCHOR_WALLET}" \
    $SEALED chain market ladder claim --market "$LADDER" || true
done
$SEALED chain market ladder show --market "$LADDER"
$SEALED chain status --benchmark "$BENCH"

echo
echo "proof summary:"
echo "  bank   $BENCH — MPC-minted; no answer key ever existed"
echo "  ladder $LADDER — $NLEGS real-model legs, argmax-settled off MPC scores"
for i in "${!LEG_MODELS[@]}"; do
  echo "  leg $i   $(PDA run "$BENCH" "$i") — ${LEG_MODELS[$i]} @ :${LEG_PORTS[$i]}"
done
