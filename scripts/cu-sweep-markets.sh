#!/usr/bin/env bash
# cu-sweep-markets.sh — companion to cu-sweep.sh: exercises the market
# instructions the main sweep misses (duel, ladder, dark reveal/finalize/
# claim, fee claims) so docs/costs.md carries a measured row for every
# public instruction. Runs the pending-latch path: markets open + fill
# while runs are unscored, then resolve once MPC finalizes.
#
# Prereqs: localnet up + MXE LIVE (scripts/localnet-up.sh, probe-mxe-live).
# Output: /tmp/cu-sweep-markets.txt (per-phase CU tables).
set -uo pipefail
cd "$(dirname "$0")/.."
export PATH="/home/joseph/.local/share/solana/install/active_release/bin:$PATH"
export ARCIUM_CLUSTER_OFFSET=0
export ANCHOR_PROVIDER_URL="${ANCHOR_PROVIDER_URL:-http://127.0.0.1:8899}"
MAIN_WALLET="${ANCHOR_WALLET:-$HOME/.config/solana/id.json}"
export ANCHOR_WALLET="$MAIN_WALLET"
SEALED="yarn --cwd packages/harness --silent tsx src/cli.ts"
OUT=/tmp/cu-sweep-markets.txt
: > "$OUT"
measure() {
  echo -e "\n### after: $1" >> "$OUT"
  node scripts/measure-cu.mjs http://127.0.0.1:8899 --slots 400 >> "$OUT" 2>&1 || true
}
PDA() { # PDA <benchmark|run|market|duel|ladder|dark> <a> [i]
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
  : kind === "duel"
  ? PublicKey.findProgramAddressSync([Buffer.from("duel"), new PublicKey(a).toBuffer(), new PublicKey(i).toBuffer(), le(0, 8)], MARKET)
  : kind === "ladder"
  ? PublicKey.findProgramAddressSync([Buffer.from("ladder"), new PublicKey(a).toBuffer(), le(i ?? 0, 8)], MARKET)
  : kind === "dark"
  ? PublicKey.findProgramAddressSync([Buffer.from("dark"), new PublicKey(a).toBuffer(), le(i ?? 0, 8)], MARKET)
  : PublicKey.findProgramAddressSync([Buffer.from("market"), new PublicKey(a).toBuffer(), le(i ?? 0, 8)], MARKET);
console.log(pda[0].toBase58());
EOF
}
say() { printf '\n=== %s ===\n' "$*"; }

ID="${CU_SWEEP_ID:-$((RANDOM % 90000 + 10000))}"
if [[ -n "${CU_SWEEP_ID:-}" && -f "/tmp/cu-mkt-bank-$ID.json" ]]; then
  say "P1: reusing sealed bank $ID (CU_SWEEP_ID set)"
else
  say "P1: authored bank build + seal"
  $SEALED bank build --seed "cu-mkt-$ID" --id "$ID" --chunks 1 --out "/tmp/cu-mkt-bank-$ID.json" || exit 1
  $SEALED chain seal --bank "/tmp/cu-mkt-bank-$ID.json" --fee-lamports 1000000 || exit 1
fi
BENCH=$(PDA benchmark "$ID")
echo "benchmark $BENCH"

say "P2: three runner wallets + mock artifacts + pending runs"
for i in 0 1 2; do
  solana-keygen new -o "/tmp/cu-leg-$ID-$i.json" --no-bip39-passphrase -f >/dev/null 2>&1 \
    || solana-keygen new -o "/tmp/cu-leg-$ID-$i.json" --no-passphrase -f >/dev/null 2>&1
  solana transfer --keypair "$MAIN_WALLET" --url "$ANCHOR_PROVIDER_URL" --allow-unfunded-recipient \
    "$(solana-keygen pubkey "/tmp/cu-leg-$ID-$i.json")" 1 >/dev/null || { echo "leg $i funding failed"; exit 1; }
done
MODELS=(mock/oracle-0.75 mock/oracle-0.5 mock/oracle-0.25)
MAIN_PK="$(solana-keygen pubkey "$MAIN_WALLET")"
for i in 0 1 2; do
  $SEALED run --bank "/tmp/cu-mkt-bank-$ID.json" --model "${MODELS[$i]}" --concurrency 4 --out "/tmp/cu-mkt-art-$ID-$i.json" || exit 1
  # runner = leg wallet (ladder legs need distinct runners); --authority pins
  # the benchmark PDA derivation to the bank's real authority.
  ANCHOR_WALLET="/tmp/cu-leg-$ID-$i.json" $SEALED chain score --bank "/tmp/cu-mkt-bank-$ID.json" --run "/tmp/cu-mkt-art-$ID-$i.json" --authority "$MAIN_PK" --create-only || exit 1
done
RUNA=$(PDA run "$BENCH" 0); RUNB=$(PDA run "$BENCH" 1); RUNC=$(PDA run "$BENCH" 2)
echo "legs: $RUNA $RUNB $RUNC"

say "P3: open + bet — duel, ladder, dark, band (runs still pending)"
DUEL=$(PDA duel "$RUNA" "$RUNB")
$SEALED chain market duel --run-a "$RUNA" --run-b "$RUNB" --resolve-by +86400 --fee-bps 100 || true
$SEALED chain market bet --market "$DUEL" --outcome 0 --lamports 20000000 || true
LADDER=$(PDA ladder "$RUNA" 0)
$SEALED chain market ladder open --legs "$RUNA,$RUNB,$RUNC" --closes-at +7200 --resolve-by +86400 --fee-bps 100 || true
$SEALED chain market ladder bet --market "$LADDER" --outcome 0 --lamports 20000000 || true
DARK=$(PDA dark "$RUNA" 0)
$SEALED chain market dark open --run "$RUNA" --threshold 16 --resolve-by +86400 --reveal-secs 600 --fee-bps 100 || true
BET_OUT=$($SEALED chain market dark bet --market "$DARK" --outcome 1 --lamports 20000000 --pos-salt 0 2>&1)
echo "$BET_OUT"
DSALT=$(echo "$BET_OUT" | grep -oE -- '--salt [0-9a-f]+' | awk '{print $2}')
MKT=$(PDA market "$RUNA" 0)
$SEALED chain market open --run "$RUNA" --threshold 16 --resolve-by +86400 --fee-bps 100 || true
$SEALED chain market bet --market "$MKT" --outcome 1 --lamports 20000000 || true
measure "duel/ladder/dark/band open + bet"

say "P4: score all three legs"
for i in 0 1 2; do
  ANCHOR_WALLET="/tmp/cu-leg-$ID-$i.json" $SEALED chain score --bank "/tmp/cu-mkt-bank-$ID.json" --run "/tmp/cu-mkt-art-$ID-$i.json" --authority "$MAIN_PK" --run-index "$i" || exit 1
done
measure "score_chunk x3 (queue + callback)"

say "P5: resolve + reveal + finalize + claims + fee sweeps"
$SEALED chain market resolve --market "$DUEL" || true
$SEALED chain market claim --market "$DUEL" --bettor "$MAIN_WALLET" || true
$SEALED chain market claim-fee --market "$DUEL" || true
$SEALED chain market ladder resolve --market "$LADDER" || true
$SEALED chain market ladder claim --market "$LADDER" --bettor "$MAIN_WALLET" || true
$SEALED chain market ladder claim-fee --market "$LADDER" || true
$SEALED chain market dark resolve --market "$DARK" || true
$SEALED chain market dark reveal --market "$DARK" --pos-salt 0 --outcome 1 --salt "$DSALT" || true
$SEALED chain market dark finalize --market "$DARK" || true
$SEALED chain market dark claim --market "$DARK" --pos-salt 0 --bettor "$MAIN_WALLET" || true
$SEALED chain market dark claim-fee --market "$DARK" || true
$SEALED chain market resolve --market "$MKT" || true
$SEALED chain market claim --market "$MKT" --bettor "$MAIN_WALLET" || true
$SEALED chain market claim-fee --market "$MKT" || true
measure "resolve + reveal + finalize + claim + fee"

say "done — tables at $OUT"
cat "$OUT"
