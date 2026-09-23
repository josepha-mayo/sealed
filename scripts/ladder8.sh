#!/usr/bin/env bash
# Maximum-width ladder race: EIGHT legs through load_legs' ordered
# remaining-accounts check, resolving with the full u8 result mask
# (the path the u16-overflow fix protects). Mock models at spread
# fractions; any outcome — sweep or dead-heat — is a valid settle.
#
# Requires: `arcium localnet` already up. Usage: scripts/ladder8.sh [seed]
set -euo pipefail
cd "$(dirname "$0")/.."
export ANCHOR_PROVIDER_URL="${ANCHOR_PROVIDER_URL:-http://127.0.0.1:8899}"
export SEALED_CLUSTER_OFFSET="${SEALED_CLUSTER_OFFSET:-0}"
SEALED="yarn -s --cwd packages/harness cli"
SEED="${1:-ladder8-$(date +%s)}"
ID=$(node -e "console.log(require('crypto').createHash('sha256').update('l8/' + process.argv[1]).digest().readUInt32LE(0) % 100000)" "$SEED")

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
  : PublicKey.findProgramAddressSync([Buffer.from("ladder"), new PublicKey(a).toBuffer(), le(i ?? 0, 8)], MARKET);
console.log(pda[0].toBase58());
EOF
}

FRACS=(0.95 0.85 0.75 0.65 0.55 0.45 0.35 0.25)

say "wait for MXE keygen"
scripts/wait-mxe.sh

say "mint a 32-item generated bank inside MPC (id=$ID)"
$SEALED chain gen --id "$ID" --chunks 1
BENCH=$(PDA benchmark "$ID")
echo "benchmark: $BENCH"

say "8 runners × 8 runs (create-only first — distinct-runner rule)"
RUNS=""
for i in $(seq 0 7); do
  KP="/tmp/l8-runner-$i.json"
  node -e "const {Keypair}=require('@solana/web3.js');const k=Keypair.generate();require('fs').writeFileSync('$KP',JSON.stringify([...k.secretKey]));console.log(k.publicKey.toBase58())" > /dev/null
  PUB=$(node -e "const {Keypair}=require('@solana/web3.js');const k=Keypair.fromSecretKey(Uint8Array.from(JSON.parse(require('fs').readFileSync('$KP','utf8'))));console.log(k.publicKey.toBase58())")
  solana airdrop 1 "$PUB" --url "$ANCHOR_PROVIDER_URL" > /dev/null 2>&1 || true
  $SEALED run --bank "bank/gen-$ID.json" --model "mock/oracle-${FRACS[$i]}" --out "/tmp/l8-run-$i.json"
  ANCHOR_WALLET="$KP" $SEALED chain score --bank "bank/gen-$ID.json" --run "/tmp/l8-run-$i.json" --create-only --authority "$(solana address)"
  R=$(PDA run "$BENCH" "$i")
  RUNS="${RUNS:+$RUNS,}$R"
  echo "leg $i: $R (mock/oracle-${FRACS[$i]})"
done

say "open the 8-leg ladder + a bet on each leg"
$SEALED chain market ladder open --legs "$RUNS" --closes-at +86400 --resolve-by +86400
LADDER=$(PDA ladder "$(echo "$RUNS" | cut -d, -f1)" 0)
echo "ladder: $LADDER"
for oc in $(seq 0 7); do
  $SEALED chain market ladder bet --market "$LADDER" --outcome "$oc" --lamports 10000000
done

say "score all 8 runs through MPC"
for i in $(seq 0 7); do
  ANCHOR_WALLET="/tmp/l8-runner-$i.json" $SEALED chain score --bank "bank/gen-$ID.json" --run "/tmp/l8-run-$i.json" --run-index "$i" --authority "$(solana address)"
done

say "resolve — argmax + full-width result mask"
$SEALED chain market ladder resolve --market "$LADDER"
$SEALED chain market ladder show --market "$LADDER"
$SEALED chain market ladder claim --market "$LADDER" || true

echo
echo "8-leg ladder settled: $LADDER"
