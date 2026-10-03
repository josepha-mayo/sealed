#!/usr/bin/env bash
# Band-market fee sweep with a FULLY-BACKED book — the all_backed guard
# cancels one-sided books on resolve, so both outcomes get a position.
set -uo pipefail
cd "$(dirname "$0")/.."
export PATH="/home/joseph/.local/share/solana/install/active_release/bin:$PATH"
export ARCIUM_CLUSTER_OFFSET=0
export ANCHOR_PROVIDER_URL="http://127.0.0.1:8899"
MAIN_WALLET="${ANCHOR_WALLET:-/home/joseph/.config/solana/id.json}"
export ANCHOR_WALLET="$MAIN_WALLET"
SEALED="yarn --cwd packages/harness --silent tsx src/cli.ts"
BANK=/tmp/cu-mkt-bank-32881.json
BENCH="2mWftVXVPrJvfLnYDsRsmbkCGoe9przsntdS6rn3J4Sk"
RUN_INDEX=4

PDA() {
  node - "$@" <<'EOF'
const { PublicKey } = require("@solana/web3.js");
const SEALED = new PublicKey("FGVuEoWpDGTqBBuR9e26t2t5mDngXgbrAj5CtuLKXLUZ");
const MARKET = new PublicKey("8VSHkhNLN3q3yBUhYmTjgKSCMA55VFzfLPXcgp4Z91vN");
const le = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const [kind, a, i] = process.argv.slice(2);
const seeds = kind === "run"
  ? [Buffer.from("run"), new PublicKey(a).toBuffer(), le(i ?? 0)]
  : [Buffer.from("market"), new PublicKey(a).toBuffer(), le(i ?? 0)];
console.log(PublicKey.findProgramAddressSync(seeds, kind === "run" ? SEALED : MARKET)[0].toBase58());
EOF
}

$SEALED run --bank "$BANK" --model mock/oracle-0.6 --concurrency 4 --out /tmp/cu-mkt-art-32881-4.json || exit 1
MAIN_PK="$(solana-keygen pubkey "$MAIN_WALLET")"
$SEALED chain score --bank "$BANK" --run /tmp/cu-mkt-art-32881-4.json --authority "$MAIN_PK" --create-only || exit 1

RUNE="$(PDA run "$BENCH" "$RUN_INDEX")"
MKT="$(PDA market "$RUNE" 1)"
echo "run=$RUNE market=$MKT"

$SEALED chain market open --run "$RUNE" --threshold 16 --resolve-by +86400 --fee-bps 100 --salt 1 || exit 1
$SEALED chain market bet --market "$MKT" --outcome 0 --lamports 10000000 || exit 1
$SEALED chain market bet --market "$MKT" --outcome 1 --lamports 20000000 || exit 1
$SEALED chain score --bank "$BANK" --run /tmp/cu-mkt-art-32881-4.json --authority "$MAIN_PK" --run-index "$RUN_INDEX" || exit 1
$SEALED chain market resolve --market "$MKT" || exit 1
$SEALED chain market claim --market "$MKT" --bettor "$MAIN_WALLET" || exit 1
$SEALED chain market claim-fee --market "$MKT" || exit 1
echo "=== CU ==="
node scripts/measure-cu.mjs http://127.0.0.1:8899 --slots 400 | grep -iE 'claim|resolve|bet|walk'
