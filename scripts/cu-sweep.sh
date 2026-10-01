#!/usr/bin/env bash
# Compute-unit sweep: run a compact tx mix per instruction family on the
# running localnet and measure CUs with measure-cu.mjs --slots right after
# each phase — the test-validator prunes history fast (~300 slots), so
# measure BETWEEN phases, then merge the printed tables into docs/costs.md.
#
# Usage: scripts/cu-sweep.sh   (localnet must be live: scripts/localnet-up.sh)
set -uo pipefail
cd "$(dirname "$0")/.."
export ARCIUM_CLUSTER_OFFSET=0
export ANCHOR_PROVIDER_URL="${ANCHOR_PROVIDER_URL:-http://127.0.0.1:8899}"
export ANCHOR_WALLET="${ANCHOR_WALLET:-$HOME/.config/solana/id.json}"
SEALED="yarn --cwd packages/harness --silent tsx src/cli.ts"
OUT=/tmp/cu-sweep-tables.txt
: > "$OUT"

measure() {
  echo -e "\n### after: $1" >> "$OUT"
  node scripts/measure-cu.mjs http://127.0.0.1:8899 --slots 300 2>/dev/null >> "$OUT"
}

PDA() { # PDA <benchmark|run|market|dark> <args...>
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
  ? PublicKey.findProgramAddressSync([Buffer.from("run"), new PublicKey(a).toBuffer(), le(i ?? 0, 8)], SEALED)
  : kind === "dark"
  ? PublicKey.findProgramAddressSync([Buffer.from("dark"), new PublicKey(a).toBuffer(), le(i ?? 0, 8)], MARKET)
  : PublicKey.findProgramAddressSync([Buffer.from("market"), new PublicKey(a).toBuffer(), le(i ?? 0, 8)], MARKET);
console.log(pda[0].toBase58());
EOF
}

ID=$((RANDOM % 90000 + 10000))
say() { printf '\n=== %s ===\n' "$*"; }

say "P1: authored bank build + seal"
$SEALED bank build --seed "cu-sweep-$ID" --id "$ID" --chunks 1 --out "/tmp/cu-bank-$ID.json" || exit 1
$SEALED chain seal --bank "/tmp/cu-bank-$ID.json" --fee-lamports 1000000 || exit 1
BENCH=$(PDA benchmark "$ID")
echo "benchmark $BENCH"
measure "seal + bank init"

say "P2: mock run artifact + run create + score queue"
ART=/tmp/cu-art-$ID.json
$SEALED run --bank "/tmp/cu-bank-$ID.json" --model mock/oracle-0.75 --concurrency 4 --out "$ART" || exit 1
$SEALED chain score --bank "/tmp/cu-bank-$ID.json" --run "$ART" --create-only || exit 1
RUN0=$(PDA run "$BENCH" 0)

# market + dark positions latch WHILE the run is pending
say "P3: market open + bet + dark open + dark bet (pending window)"
MKT=$(PDA market "$RUN0" 0)
$SEALED chain market open --run "$RUN0" --threshold 16 --resolve-by +86400 || true
$SEALED chain market bet --market "$MKT" --outcome 1 --lamports 20000000 || true
DARK=$(PDA dark "$RUN0" 0)
$SEALED chain market dark open --run "$RUN0" --threshold 16 --resolve-by +86400 || true
$SEALED chain market dark bet --market "$DARK" --outcome 1 --lamports 20000000 || true

say "P4: land the score"
$SEALED chain score --bank "/tmp/cu-bank-$ID.json" --run "$ART" --run-index 0 || exit 1
measure "score + pending-window market ixs"

say "P5: resolve + claim + fees"
$SEALED chain market resolve --market "$MKT" || true
$SEALED chain market claim --market "$MKT" || true
$SEALED chain market dark resolve --market "$DARK" || true
$SEALED chain market dark claim --market "$DARK" || true
measure "resolve/claim/fee"

say "P6: reshare grant + reveal part (sealed bank)"
$SEALED chain reshare --benchmark "$BENCH" --chunk 0 --part 0 --to "$(solana-keygen pubkey $ANCHOR_WALLET 2>/dev/null || solana address)" || true
$SEALED chain reveal --benchmark "$BENCH" --chunk 0 --part 0 || true
measure "reshare + reveal"

echo; echo "=== merged CU tables -> $OUT ==="; cat "$OUT"
