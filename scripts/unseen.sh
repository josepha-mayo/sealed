#!/usr/bin/env bash
# The unseen-exam market: a prediction market on an exam nobody can read.
#
# A PRIVATE generated bank's specs exist only as ciphertext on-chain
# (PrivItemChunk accounts) — decryptable solely by the authority's x25519
# key. We open a parimutuel market on a run against that bank WHILE the run
# is pending, let bettors stake, then score through MPC and resolve. At no
# point — before, during, or after the market — do the questions exist in
# plaintext anywhere but the authority's local file. A public orderbook can
# list markets on events; it cannot list a market on an event that is
# itself confidential. This one can.
#
# Requires: `arcium localnet` already up. Usage: scripts/unseen.sh [seed]
set -euo pipefail
cd "$(dirname "$0")/.."
export ANCHOR_PROVIDER_URL="${ANCHOR_PROVIDER_URL:-http://127.0.0.1:8899}"
export SEALED_CLUSTER_OFFSET="${SEALED_CLUSTER_OFFSET:-0}"
SEALED="yarn -s --cwd packages/harness cli"
SEED="${1:-unseen-$(date +%s)}"
ID=$(node -e "console.log(require('crypto').createHash('sha256').update('priv/' + process.argv[1]).digest().readUInt32LE(0) % 100000)" "$SEED")

say() { printf '\n=== %s ===\n' "$*"; }

PDA() {
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

say "1/5 wait for MXE, then comp defs + circuits (once per deployment)"
scripts/wait-mxe.sh
$SEALED chain init

say "2/5 mint a PRIVATE bank (id=$ID) — specs land ONLY as ciphertext"
$SEALED chain gen-private --id "$ID" --chunks 1 --out "/tmp/unseen-$ID.json"
PBENCH=$(PDA benchmark "$ID")
echo "private benchmark PDA: $PBENCH"
echo "on-chain it holds only ciphertext — nothing to read:"
$SEALED chain pitems --benchmark "$PBENCH" | head -5 || true

say "3/5 create a PENDING run + open a market on the unseen exam"
# The authority holds the only plaintext (its local file) — it runs a mock
# model and commits outputs_root before any scoring happens.
$SEALED run --bank "/tmp/unseen-$ID.json" --model mock/oracle-0.65 --out "/tmp/unseen-run-$ID.json"
$SEALED chain score --bank "/tmp/unseen-$ID.json" --run "/tmp/unseen-run-$ID.json" --create-only
RUN=$(PDA run "$PBENCH" 0)
echo "run PDA (pending, outputs committed): $RUN"

# The market opens while the run is pending. Bettors stake on a score whose
# questions they can never read — the exam itself is the confidential event.
$SEALED chain market open --run "$RUN" --threshold 20 --resolve-by +86400
MKT=$(PDA market "$RUN" 0)
echo "market PDA: $MKT — bets now latch before any score can leak"
$SEALED chain market bet --market "$MKT" --outcome 1 --lamports 200000000
# The other side must come from a second wallet (one position PDA per bettor).
JUDGE=$(node -e 'const {Keypair}=require("@solana/web3.js");const k=Keypair.generate();require("fs").writeFileSync("/tmp/unseen-judge.json",JSON.stringify([...k.secretKey]));console.log(k.publicKey.toBase58())')
solana airdrop 1 "$JUDGE" --url "$ANCHOR_PROVIDER_URL" >/dev/null 2>&1 || true
$SEALED chain market bet --market "$MKT" --outcome 0 --lamports 80000000 --bettor /tmp/unseen-judge.json

say "4/5 score the run through MPC — still no plaintext on-chain"
$SEALED chain score --bank "/tmp/unseen-$ID.json" --run "/tmp/unseen-run-$ID.json" --run-index 0

say "5/5 resolve + claim — the unseen exam pays out"
$SEALED chain market resolve --market "$MKT"
$SEALED chain market claim --market "$MKT" || true
$SEALED chain market claim --market "$MKT" --bettor /tmp/unseen-judge.json || true
$SEALED chain market show --market "$MKT" || true

echo
echo "proof summary:"
echo "  bank   $PBENCH — specs were ciphertext-only for the market's whole life"
echo "  run    $RUN — score written by the MPC callback, not the operator"
echo "  market $MKT — opened + filled while the run was pending"
echo "verify in the explorer: python3 -m http.server -d . 8788 -> http://localhost:8788/web/?rpc=$ANCHOR_PROVIDER_URL"
