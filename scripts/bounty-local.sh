#!/usr/bin/env bash
# Capability bounty, full lifecycle on a fresh MPC-minted bank:
#   a sponsor escrows SOL against "first run to score >= T on this exam" —
#   the pot pays the winning RUN's operator (not a bettor, not the trigger).
#
#   1. mint a generated bank inside MPC (no answer key exists)
#   2. bounty open (plus the two bait rejections: threshold > max, past deadline)
#   3. a model answers + MPC scores the run
#   4. claim_bounty — permissionless trigger, payout lands on run.runner
#   5. a second bounty lapses -> expire_bounty refunds the sponsor
#
# Requires: localnet up + MXE live. A real model endpoint is optional —
# MODEL=mock/oracle-0.5 (default) answers deterministically offline.
# Usage: scripts/bounty-local.sh [bank-id-seed]
set -uo pipefail
cd "$(dirname "$0")/.."
command -v solana >/dev/null 2>&1 || \
  export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
export ARCIUM_CLUSTER_OFFSET=0
export ANCHOR_PROVIDER_URL="${ANCHOR_PROVIDER_URL:-http://127.0.0.1:8899}"
export ANCHOR_WALLET="${ANCHOR_WALLET:-$HOME/.config/solana/id.json}"
SEALED="yarn --cwd packages/harness --silent tsx src/cli.ts"
MODEL="${MODEL:-mock/oracle-0.5}"
BASE="${SEALED_API_BASE:-http://127.0.0.1:8081/v1}"
KEY="${SEALED_API_KEY:-local}"
THRESHOLD="${THRESHOLD:-4}"
SEED="${1:-bounty-$(date +%s)}"
ID=$(node -e "console.log(require('crypto').createHash('sha256').update('bounty/' + process.argv[1]).digest().readUInt32LE(0) % 100000)" "$SEED")

say() { printf '\n=== %s ===\n' "$*"; }

PDA() { # PDA <benchmark|run|bounty> <args...>
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
  : kind === "bounty"
  ? PublicKey.findProgramAddressSync([Buffer.from("bounty"), new PublicKey(a).toBuffer(), wallet().toBuffer(), le(i ?? 0, 8)], MARKET)
  : PublicKey.findProgramAddressSync([Buffer.from("run"), new PublicKey(a).toBuffer(), le(i ?? 0, 8)], SEALED);
console.log(pda[0].toBase58());
EOF
}

say "0/6 endpoint sanity (mock/oracle-* needs none)"
if [ "${MODEL#mock/}" = "$MODEL" ]; then
  CODE=$(curl -s -o /tmp/bounty-ep.json -w "%{http_code}" --max-time 60 \
    "$BASE/chat/completions" -H "content-type: application/json" \
    -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply with only the integer. What is 2+3? ANSWER:\"}],\"max_tokens\":16,\"temperature\":0}")
  echo "  $BASE model=$MODEL -> HTTP $CODE"
  [ "$CODE" = 200 ] || { echo "endpoint not answering — start it or MODEL=mock/oracle-0.5"; exit 1; }
fi

say "1/6 wait for MXE + mint a fresh exam inside MPC (id=$ID, 32 items)"
scripts/wait-mxe.sh
$SEALED chain init
$SEALED chain gen --id "$ID" --chunks 1
BENCH=$(PDA benchmark "$ID")
echo "benchmark PDA: $BENCH"
for i in $(seq 1 24); do
  [ -f "packages/harness/bank/gen-$ID.json" ] && break
  sleep 5
done
[ -f "packages/harness/bank/gen-$ID.json" ] || { echo "gen-$ID.json never landed"; exit 1; }

say "2/6 sponsor escrows 0.1 SOL — 'first run to score >= $THRESHOLD takes it'"
echo "  (bait rejection 1: threshold 33 > the bank's 32-item max)"
$SEALED chain market bounty open --bank "$BENCH" --threshold 33 --lamports 50000000 --deadline +3600 --salt 7 \
  && echo "  !! should have been rejected" || echo "  rejected as expected"
echo "  (bait rejection 2: deadline inside the 60s minimum)"
$SEALED chain market bounty open --bank "$BENCH" --threshold "$THRESHOLD" --lamports 50000000 --deadline +1 --salt 8 \
  && echo "  !! should have been rejected" || echo "  rejected as expected"
BOUNTY=$(PDA bounty "$BENCH" 0)
$SEALED chain market bounty open --bank "$BENCH" --threshold "$THRESHOLD" --lamports 100000000 --deadline +3600 || exit 1
$SEALED chain market bounty show --bounty "$BOUNTY"

say "3/6 an independent operator answers the exam ($MODEL) — run postdates the bounty"
RUNNER_KP=/tmp/bounty-runner-$ID.json
[ -f "$RUNNER_KP" ] || solana-keygen new --no-bip39-passphrase -o "$RUNNER_KP" --force >/dev/null 2>&1
RUNNER=$(solana-keygen pubkey "$RUNNER_KP")
solana airdrop 0.5 "$RUNNER" --url "$ANCHOR_PROVIDER_URL" >/dev/null 2>&1 || true
echo "  runner=$RUNNER (distinct from sponsor — self-claim is rejected on-chain)"
ART=/tmp/bounty-run-$ID.json
SEALED_API_BASE="$BASE" SEALED_API_KEY="$KEY" ANCHOR_WALLET="$RUNNER_KP" \
  $SEALED run --bank "bank/gen-$ID.json" --model "$MODEL" \
  --concurrency 1 --max-tokens 256 --retries 8 --out "$ART" || exit 1
python3 - "$ART" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
print("localCorrect:", d.get("localCorrect"), "/", d.get("itemCount"))
PY

say "4/6 MPC scores the run — the bounty oracle is Run.correct, cluster-written"
AUTH=$(solana-keygen pubkey "$ANCHOR_WALLET")
ANCHOR_WALLET="$RUNNER_KP" $SEALED chain score --bank "bank/gen-$ID.json" --run "$ART" --authority "$AUTH" --create-only || exit 1
ANCHOR_WALLET="$RUNNER_KP" $SEALED chain score --bank "bank/gen-$ID.json" --run "$ART" --authority "$AUTH" --run-index 0 || exit 1
RUN0=$(PDA run "$BENCH" 0)

say "5/6 permissionless claim — the pot lands on run.runner"
$SEALED chain market bounty claim --bounty "$BOUNTY" --run "$RUN0" || exit 1
$SEALED chain market bounty show --bounty "$BOUNTY"
echo "  (bait rejection 3: a second claim on the resolved bounty)"
$SEALED chain market bounty claim --bounty "$BOUNTY" --run "$RUN0" \
  && echo "  !! should have been rejected" || echo "  rejected as expected"

say "6/6 second bounty lapses unclaimed -> sponsor refund"
BOUNTY2=$(PDA bounty "$BENCH" 9)
$SEALED chain market bounty open --bank "$BENCH" --threshold 30 --lamports 50000000 --deadline +75 --salt 9 || exit 1
echo "  waiting out the 75s deadline..."
sleep 80
$SEALED chain market bounty expire --bounty "$BOUNTY2" || exit 1

echo
echo "proof summary:"
echo "  bank    $BENCH — MPC-minted"
echo "  bounty  $BOUNTY — claimed by run $RUN0 ($MODEL)"
echo "  bounty2 $BOUNTY2 — expired, escrow returned to sponsor"
