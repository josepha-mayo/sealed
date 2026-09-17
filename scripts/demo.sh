#!/usr/bin/env bash
# Full Sealed demo on the running localnet.
#
# Part A (the headline): mint a benchmark INSIDE MPC — item specs drawn from
#   ArcisRNG, answers computed + fingerprinted in-circuit, born encrypted to
#   the MXE key. No answer key ever exists in plaintext.
# Then: run a mock model, score through real MPC, and settle markets on the
# finalized score.
#
# Requires: `arcium localnet` already up. Usage: scripts/demo.sh [bank-id-seed]
set -uo pipefail
cd "$(dirname "$0")/.."
export ANCHOR_PROVIDER_URL="${ANCHOR_PROVIDER_URL:-http://127.0.0.1:8899}"
export SEALED_CLUSTER_OFFSET="${SEALED_CLUSTER_OFFSET:-0}"
SEALED="yarn -s --cwd packages/harness cli"
SEED="${1:-demo}"
ID=$(node -e "console.log(require('crypto').createHash('sha256').update('gen/' + process.argv[1]).digest().readUInt32LE(0) % 100000)" "$SEED")

say() { printf '\n=== %s ===\n' "$*"; }

PDA() { # PDA <market|run|benchmark> <args...>
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
  : PublicKey.findProgramAddressSync([Buffer.from("market"), new PublicKey(a).toBuffer(), le(i ?? 0, 8)], MARKET);
console.log(pda[0].toBase58());
EOF
}

say "1/6 comp defs + circuits (once per deployment)"
$SEALED chain init

say "2/6 mint a generated benchmark inside MPC (id=$ID, 64 items, NO answer key)"
$SEALED chain gen --id "$ID" --chunks 2
BENCH=$(PDA benchmark "$ID")
echo "benchmark PDA: $BENCH"

PID=$((ID + 1))
say "2b mint a PRIVATE bank (id=$PID) — specs stay encrypted to the authority"
$SEALED chain gen-private --id "$PID" --chunks 1 --out "/tmp/priv-$PID.json"
PBENCH=$(PDA benchmark "$PID")
echo "private benchmark PDA: $PBENCH — onchain it holds ONLY ciphertext (see explorer)"

say "2c selective disclosure — hand a 'judge' key the questions, onchain"
# A delegate stands in for a judge/runner; the MPC re-encrypts part 0's specs
# to their key. The grant PDA records WHO can see WHICH parts — the answers
# never move. The delegate then decrypts the grant with their own wallet.
JUDGE=$(node -e 'const {Keypair}=require("@solana/web3.js");const k=Keypair.generate();require("fs").writeFileSync("/tmp/judge-kp.json",JSON.stringify([...k.secretKey]));console.log(k.publicKey.toBase58())')
$SEALED chain reshare --benchmark "$PBENCH" --chunk 0 --part 0 --to "$JUDGE"
echo "grant trail:"; $SEALED chain grants --benchmark "$PBENCH"
echo "the delegate decrypts the same items the authority sees:"
ANCHOR_WALLET=/tmp/judge-kp.json $SEALED chain grant --benchmark "$PBENCH" --chunk 0 --part 0

say "3/6 create run 0 (mock model, 75% correct) — PENDING, outputs committed"
$SEALED run --bank "bank/gen-$ID.json" --model mock/oracle-0.75 --out /tmp/run-gen.json
$SEALED chain score --bank "bank/gen-$ID.json" --run /tmp/run-gen.json --create-only
RUN0=$(PDA run "$BENCH" 0)
echo "run PDA: $RUN0"

say "4/6 open markets on the pending run + place bets"
$SEALED chain market open --run "$RUN0" --threshold 48
MKT_BIN=$(PDA market "$RUN0" 0)
$SEALED chain market open --run "$RUN0" --edges 32,48 --salt 1
MKT_3WAY=$(PDA market "$RUN0" 1)
$SEALED chain market bet --market "$MKT_BIN" --outcome 1 --lamports 300000000
for oc in 0 1 2; do $SEALED chain market bet --market "$MKT_3WAY" --outcome "$oc" --lamports 10000000; done

say "5/6 score run 0 through MPC (hash-compare vs answers born encrypted)"
$SEALED chain score --bank "bank/gen-$ID.json" --run /tmp/run-gen.json --run-index 0

say "6/6 resolve markets + claim, then leaderboard"
$SEALED chain market resolve --market "$MKT_BIN"
$SEALED chain market resolve --market "$MKT_3WAY"
$SEALED chain market claim --market "$MKT_BIN" || true
$SEALED chain market claim --market "$MKT_3WAY" || true
$SEALED chain status --benchmark "$BENCH"

echo
echo "the minted item specs are public — see them rendered in the explorer:"
echo "  python3 -m http.server -d web 8788  →  http://localhost:8788/?rpc=$ANCHOR_PROVIDER_URL"
echo "or:  $SEALED chain items --benchmark $BENCH"
echo "the private bank's specs are ciphertext-only onchain; only the authority can render them:"
echo "  $SEALED chain pitems --benchmark $PBENCH"
