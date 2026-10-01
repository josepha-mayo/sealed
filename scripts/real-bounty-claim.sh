#!/usr/bin/env bash
# Real-model capability-bounty claim on the running localnet:
# a REAL open-weights model's run (qwen2.5-3b) provably clears the threshold
# through MPC scoring, then the permissionless claim pays its operator.
# Usage: scripts/real-bounty-claim.sh <benchmark> <bounty> <artifact.json> [runner-keypair]
set -euo pipefail
cd "$(dirname "$0")/.."
export ARCIUM_CLUSTER_OFFSET=0
export ANCHOR_PROVIDER_URL="${ANCHOR_PROVIDER_URL:-http://127.0.0.1:8899}"
export ANCHOR_WALLET="${ANCHOR_WALLET:-$HOME/.config/solana/id.json}"
SOLBIN="$HOME/.local/share/solana/install/active_release/bin"
SEALED="yarn --cwd packages/harness --silent tsx src/cli.ts"

BENCH="$1"; BOUNTY="$2"; ART="$3"; RUNNER_KP="${4:-/tmp/real-runner.json}"
AUTH=$("$SOLBIN/solana-keygen" pubkey "$ANCHOR_WALLET")
RUNNER=$("$SOLBIN/solana-keygen" pubkey "$RUNNER_KP")

echo "benchmark=$BENCH bounty=$BOUNTY runner=$RUNNER authority=$AUTH"
"$SOLBIN/solana" transfer "$RUNNER" 0.1 --url "$ANCHOR_PROVIDER_URL" --fee-payer "$ANCHOR_WALLET" --allow-unfunded-recipient || true

say() { printf '\n=== %s ===\n' "$*"; }
say "create run (runner=$RUNNER, authority=$AUTH)"
ANCHOR_WALLET="$RUNNER_KP" $SEALED chain score --bank "bank/gen-$(basename "$ART" .json | sed 's/.*-//').json" --run "$ART" --authority "$AUTH" --create-only
say "MPC scoring"
ANCHOR_WALLET="$RUNNER_KP" $SEALED chain score --bank "bank/gen-$(basename "$ART" .json | sed 's/.*-//').json" --run "$ART" --authority "$AUTH" --run-index "${RUN_INDEX:-0}"
say "permissionless claim — pot lands on run.runner ($RUNNER)"
$SEALED chain market bounty claim --bounty "$BOUNTY" --run "$(node -e "
const {PublicKey,Keypair}=require('@solana/web3.js');const{readFileSync}=require('fs');const{homedir}=require('os');
const w=Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync('$ANCHOR_WALLET','utf8')))).publicKey;
const le=(n)=>{const b=Buffer.alloc(8);b.writeBigUInt64LE(BigInt(n));return b};
console.log(PublicKey.findProgramAddressSync([Buffer.from('run'),new PublicKey('$BENCH').toBuffer(),le(${RUN_INDEX:-0})],new PublicKey('FGVuEoWpDGTqBBuR9e26t2t5mDngXgbrAj5CtuLKXLUZ'))[0].toBase58())"
)"
$SEALED chain market bounty show --bounty "$BOUNTY"
