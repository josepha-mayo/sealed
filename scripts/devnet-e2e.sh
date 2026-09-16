#!/usr/bin/env bash
# Devnet completion demo — run AFTER scripts/seal-devnet-retry.sh reports the
# devnet benchmark LIVE. Creates a pending run on it, opens binary + 3-way
# markets, bets, scores through devnet MPC, resolves + claims.
# Usage: ANCHOR_PROVIDER_URL=https://api.devnet.solana.com ARCIUM_CLUSTER_OFFSET=456 \
#          scripts/devnet-e2e.sh [run-file]
set -uo pipefail
cd "$(dirname "$0")/.."
export ANCHOR_PROVIDER_URL="${ANCHOR_PROVIDER_URL:-https://api.devnet.solana.com}"
export ARCIUM_CLUSTER_OFFSET="${ARCIUM_CLUSTER_OFFSET:-456}"
SEALED="yarn -s --cwd packages/harness cli"
BANK="${BANK:-$HOME/sealed-data/bank-7.json}"
RUNF="${1:-$HOME/sealed-data/run-nemotron-7.json}"

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

BANKID=$(node -e "const b=JSON.parse(require('fs').readFileSync('$BANK','utf8')); console.log(b.benchmarkId ?? b.id)")
BENCH=$(PDA benchmark "$BANKID")
echo "benchmark: $BENCH"
$SEALED chain status --benchmark "$BENCH" || { echo "benchmark not live yet — run seal-devnet-retry.sh"; exit 1; }

say "1/4 create pending run (outputs committed, unscored)"
OUT=$($SEALED chain score --bank "$BANK" --run "$RUNF" --create-only 2>&1)
echo "$OUT"
RUNIDX=$(echo "$OUT" | grep -oP 'create_run #\K\d+' | head -1)
RUNIDX="${RUNIDX:-0}"
RUN=$(PDA run "$BENCH" "$RUNIDX")
echo "run PDA: $RUN (index $RUNIDX)"

say "2/4 open binary + 3-way markets on the pending run, place bets"
$SEALED chain market open --run "$RUN" --threshold 50 --salt 0
$SEALED chain market open --run "$RUN" --edges 32,48 --salt 1
MKT_BIN=$(PDA market "$RUN" 0)
MKT_3WAY=$(PDA market "$RUN" 1)
$SEALED chain market bet --market "$MKT_BIN" --outcome 1 --lamports 200000000
for oc in 0 1 2; do $SEALED chain market bet --market "$MKT_3WAY" --outcome "$oc" --lamports 10000000; done

say "3/4 score the run through devnet MPC"
$SEALED chain score --bank "$BANK" --run "$RUNF" --run-index "$RUNIDX"

say "4/4 resolve markets + claim"
$SEALED chain market resolve --market "$MKT_BIN"
$SEALED chain market resolve --market "$MKT_3WAY"
$SEALED chain market claim --market "$MKT_BIN" || true
$SEALED chain market claim --market "$MKT_3WAY" || true
$SEALED chain status --benchmark "$BENCH"
