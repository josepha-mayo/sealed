#!/usr/bin/env bash
# One-shot dark-market claim cycle with the 60s reveal-window floor —
# captures FinalizeDark / ClaimDark / ClaimFeeDark CU rows that the
# 600s-window sweep couldn't reach inside the block window.
# Dark markets only open on PENDING runs, so this mints its own run first.
set -uo pipefail
cd "$(dirname "$0")/.."
export PATH="/home/joseph/.local/share/solana/install/active_release/bin:$PATH"
export ARCIUM_CLUSTER_OFFSET=0
export ANCHOR_PROVIDER_URL="${ANCHOR_PROVIDER_URL:-http://127.0.0.1:8899}"
MAIN_WALLET="${ANCHOR_WALLET:-/home/joseph/.config/solana/id.json}"
export ANCHOR_WALLET="$MAIN_WALLET"
SEALED="yarn --cwd packages/harness --silent tsx src/cli.ts"
BANK=/tmp/cu-mkt-bank-32881.json
BENCH="2mWftVXVPrJvfLnYDsRsmbkCGoe9przsntdS6rn3J4Sk"
RUN_INDEX=3

PDA() {
  node - "$@" <<'EOF'
const { PublicKey } = require("@solana/web3.js");
const SEALED = new PublicKey("FGVuEoWpDGTqBBuR9e26t2t5mDngXgbrAj5CtuLKXLUZ");
const MARKET = new PublicKey("8VSHkhNLN3q3yBUhYmTjgKSCMA55VFzfLPXcgp4Z91vN");
const le = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const [kind, a, i] = process.argv.slice(2);
const seeds = kind === "run"
  ? [Buffer.from("run"), new PublicKey(a).toBuffer(), le(i ?? 0)]
  : [Buffer.from("dark"), new PublicKey(a).toBuffer(), le(i ?? 0)];
console.log(PublicKey.findProgramAddressSync(seeds, kind === "run" ? SEALED : MARKET)[0].toBase58());
EOF
}

# fresh pending run on the same bank (run #3, mock 0.75 → ~24/32)
$SEALED run --bank "$BANK" --model mock/oracle-0.75 --concurrency 4 --out /tmp/cu-mkt-art-32881-3.json || exit 1
MAIN_PK="$(solana-keygen pubkey "$MAIN_WALLET")"
$SEALED chain score --bank "$BANK" --run /tmp/cu-mkt-art-32881-3.json --authority "$MAIN_PK" --create-only || exit 1

RUND="$(PDA run "$BENCH" "$RUN_INDEX")"
DARK="$(PDA dark "$RUND" 9)"
echo "run=$RUND dark=$DARK"

$SEALED chain market dark open --run "$RUND" --threshold 16 --resolve-by +86400 --reveal-secs 60 --fee-bps 100 --salt 9 || exit 1
BET_OUT=$($SEALED chain market dark bet --market "$DARK" --outcome 1 --lamports 20000000 --pos-salt 0 2>&1)
echo "$BET_OUT"
DSALT=$(echo "$BET_OUT" | grep -oE -- '--salt [0-9a-f]+' | awk '{print $2}')
# position latched while pending — now let MPC finalize the run
$SEALED chain score --bank "$BANK" --run /tmp/cu-mkt-art-32881-3.json --authority "$MAIN_PK" --run-index "$RUN_INDEX" || exit 1
$SEALED chain market dark resolve --market "$DARK" || exit 1
$SEALED chain market dark reveal --market "$DARK" --pos-salt 0 --outcome 1 --salt "$DSALT" || exit 1
echo "waiting 65s for the reveal window to close..."
sleep 65
$SEALED chain market dark finalize --market "$DARK" || exit 1
$SEALED chain market dark claim --market "$DARK" --pos-salt 0 --bettor "$MAIN_WALLET" || exit 1
$SEALED chain market dark claim-fee --market "$DARK" || exit 1
echo "=== CU ==="
node scripts/measure-cu.mjs http://127.0.0.1:8899 --slots 400 | grep -iE 'dark|claim|walk'
