#!/usr/bin/env bash
# Full Sealed demo on the running localnet: seal a benchmark, create a run,
# open binary + 3-way markets while it's pending, bet, then score through
# real MPC and resolve + claim. Requires: `arcium localnet` already up.
# Usage: scripts/demo.sh [bank-seed]
set -uo pipefail
cd "$(dirname "$0")/.."
export ANCHOR_PROVIDER_URL="${ANCHOR_PROVIDER_URL:-http://127.0.0.1:8899}"
SEALED="yarn -s --cwd packages/harness cli"
SEED="${1:-demo}"
BANK="bank/demo-$SEED.json"
ID=42

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

say "1/7 build benchmark bank (seed=$SEED, id=$ID, 64 items)"
$SEALED bank build --seed "$SEED" --id "$ID" --chunks 2 --out "$BANK"
BENCH=$(PDA benchmark "$ID")
echo "benchmark PDA: $BENCH"

say "2/7 seal answers into Arcium MPC ciphertext"
$SEALED chain seal --bank "$BANK"

say "3/7 create run 0 (mock model, 80% correct) — PENDING, outputs committed"
$SEALED run --bank "$BANK" --model mock/oracle-0.8 --out /tmp/run-good.json
$SEALED chain score --bank "$BANK" --run /tmp/run-good.json --create-only
RUN0=$(PDA run "$BENCH" 0)
echo "run PDA: $RUN0"

say "4/7 open markets on the pending run + place bets"
$SEALED chain market open --run "$RUN0" --threshold 50
MKT_BIN=$(PDA market "$RUN0" 0)
$SEALED chain market open --run "$RUN0" --edges 32,48 --salt 1
MKT_3WAY=$(PDA market "$RUN0" 1)
$SEALED chain market bet --market "$MKT_BIN" --outcome 1 --lamports 300000000
for oc in 0 1 2; do $SEALED chain market bet --market "$MKT_3WAY" --outcome "$oc" --lamports 10000000; done

say "5/7 score run 0 through MPC"
$SEALED chain score --bank "$BANK" --run /tmp/run-good.json

say "6/7 resolve markets + claim"
$SEALED chain market resolve --market "$MKT_BIN"
$SEALED chain market resolve --market "$MKT_3WAY"
$SEALED chain market claim --market "$MKT_BIN" || true
$SEALED chain market claim --market "$MKT_3WAY" || true

say "7/7 leaderboard"
$SEALED chain status --benchmark "$BENCH"

echo
echo "explorer: python3 -m http.server -d web 8890  →  http://localhost:8890  (rpc: $ANCHOR_PROVIDER_URL)"
