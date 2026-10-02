#!/usr/bin/env bash
# Prefund-grief demo: dust a program PDA, watch `unbrick_pda` reclaim it,
# then prove the init path lands.
#
#   1. mint a small MPC-generated bank (needs MXE live)
#   2. attacker sends rent-dust to the bank's FIRST run PDA (grief)
#   3. a permissionless rescuer sweeps the dust via `chain unbrick`
#   4. `create_run` lands on the cleaned address — plus the two guards:
#      wrong seeds reject (NotProgramPda), a live account refuses to drain
#      (NotGriefedPda)
#
# Note: Anchor 1.0's `init` codegen already tolerates prefunded PDAs (it
# tops up to rent-exempt, then allocate+assigns — the dust becomes a rent
# subsidy). `unbrick_pda` is the reclaim + defense-in-depth for the raw
# `create_account` path `init_signer_pda` uses; this demo shows the claw-back.
# Usage: scripts/unbrick-demo.sh [bank-id-seed]
set -uo pipefail
cd "$(dirname "$0")/.."
command -v solana >/dev/null 2>&1 || \
  export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
export ARCIUM_CLUSTER_OFFSET=0
export ANCHOR_PROVIDER_URL="${ANCHOR_PROVIDER_URL:-http://127.0.0.1:8899}"
export ANCHOR_WALLET="${ANCHOR_WALLET:-$HOME/.config/solana/id.json}"
SEALED="yarn --cwd packages/harness --silent tsx src/cli.ts"
SEED="${1:-unbrick-$(date +%s)}"
ID=$(node -e "console.log(require('crypto').createHash('sha256').update('unbrick/' + process.argv[1]).digest().readUInt32LE(0) % 100000)" "$SEED")

say() { printf '\n=== %s ===\n' "$*"; }
PDA() { # PDA <benchmark|run> <args...>
  node - "$@" <<'EOF'
const { PublicKey, Keypair } = require("@solana/web3.js");
const { readFileSync } = require("fs");
const { homedir } = require("os");
const SEALED = new PublicKey("FGVuEoWpDGTqBBuR9e26t2t5mDngXgbrAj5CtuLKXLUZ");
const wallet = () => Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(process.env.ANCHOR_WALLET ?? `${homedir()}/.config/solana/id.json`, "utf8")))).publicKey;
const le = (n, w) => { const b = Buffer.alloc(w); w === 4 ? b.writeUInt32LE(Number(n)) : b.writeBigUInt64LE(BigInt(n)); return b; };
const [kind, ...a] = process.argv.slice(2);
const seeds = kind === "benchmark"
  ? [Buffer.from("benchmark"), wallet().toBuffer(), le(a[0], 4)]
  : [Buffer.from("run"), new PublicKey(a[0]).toBuffer(), le(a[1], 8)];
console.log(PublicKey.findProgramAddressSync(seeds, SEALED)[0].toBase58());
EOF
}

say "1/5 mint a one-chunk MPC bank (id=$ID)"
scripts/wait-mxe.sh
$SEALED chain gen --id "$ID" --chunks 1
BENCH=$(PDA benchmark "$ID")
# `chain gen` writes relative to the harness cwd (packages/harness).
BANKJSON="bank/gen-$ID.json"
for i in $(seq 1 24); do
  [ -f "packages/harness/$BANKJSON" ] && break
  sleep 5
done
[ -f "packages/harness/$BANKJSON" ] || { echo "gen-$ID.json never landed"; exit 1; }
RUNPDA=$(PDA run "$BENCH" 0)
echo "  benchmark=$BENCH  next-run PDA=$RUNPDA"

say "2/5 attacker griefs the run-0 PDA with rent dust (0.002 SOL)"
solana transfer "$RUNPDA" 0.002 --url "$ANCHOR_PROVIDER_URL" --allow-unfunded-recipient >/dev/null
solana account "$RUNPDA" --url "$ANCHOR_PROVIDER_URL" | head -4

say "3/5 a permissionless rescuer sweeps the grief via unbrick_pda"
$SEALED chain unbrick sealed run "$BENCH" 0 || exit 1
echo "  after sweep:"
solana account "$RUNPDA" --url "$ANCHOR_PROVIDER_URL" 2>&1 | head -3 || true
echo "  (re-running the sweep now fails — nothing left to drain)"
$SEALED chain unbrick sealed run "$BENCH" 0 \
  && echo "  !! second drain should have failed" || echo "  rejected as expected"

say "4/5 create_run lands on the cleaned PDA (mock model, create-only)"
$SEALED run --bank "$BANKJSON" --model mock/oracle-0.5 --out "/tmp/unbrick-run-$ID.json"
$SEALED chain score --bank "$BANKJSON" --run "/tmp/unbrick-run-$ID.json" --create-only
solana account "$RUNPDA" --url "$ANCHOR_PROVIDER_URL" | head -3

say "5/5 and a live program account can NEVER be drained"
$SEALED chain unbrick sealed run "$BENCH" 0 \
  && echo "  !! draining a live run should have failed" || echo "  rejected as expected (NotGriefedPda)"
echo
echo "unbrick demo complete: griefed dust reclaimed, init landed, guards held."
