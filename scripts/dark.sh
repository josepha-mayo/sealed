#!/usr/bin/env bash
# The dark market: a prediction market where the POSITIONS are sealed.
#
# A regular parimutuel market hides the score until MPC lands it — but every
# bet still shouts its side on the wire. A dark market hides the SIDE: the
# bet transaction carries only
#   sha256("sealed/dark" ‖ market ‖ bettor ‖ outcome u8 ‖ amount u64le ‖ salt32)
# so an observer sees THAT two wallets staked, the public pool, and public
# amounts — never who backed which bucket. After the run finalizes, the
# market resolves like any other, then opens a reveal window: winners who
# post their preimage get counted into win_total; no-shows forfeit into the
# pot; zero reveals cancels the market outright (gross refunds, no preimage
# needed). Amounts stay public — this demo's wager sizes are visible; the
# disclosed limitation lives in the program comments.
#
# Requires: `arcium localnet` already up. Usage: scripts/dark.sh [seed]
set -euo pipefail
cd "$(dirname "$0")/.."
export ANCHOR_PROVIDER_URL="${ANCHOR_PROVIDER_URL:-http://127.0.0.1:8899}"
export SEALED_CLUSTER_OFFSET="${SEALED_CLUSTER_OFFSET:-0}"
export ARCIUM_CLUSTER_OFFSET="${ARCIUM_CLUSTER_OFFSET:-$SEALED_CLUSTER_OFFSET}"
SEALED="yarn -s --cwd packages/harness cli"
SEED="${1:-dark-$(date +%s)}"
ID=$(node -e "console.log(require('crypto').createHash('sha256').update('dark/' + process.argv[1]).digest().readUInt32LE(0) % 100000)" "$SEED")

# Demo-friendly knobs: a 5-minute reveal window beats the 24h production
# default; 100bps gives claim-fee something to sweep.
REVEAL_SECS="${REVEAL_SECS:-300}"
FEE_BPS="${FEE_BPS:-100}"
THRESHOLD=20            # binary buckets: [0] score < 20  vs  [1] score >= 20 (of 32)
WALLET_KP="${ANCHOR_WALLET:-$HOME/.config/solana/id.json}"
TMP=$(mktemp -d /tmp/dark-demo-XXXXXX)

say() { printf '\n=== %s ===\n' "$*"; }

PDA() { # PDA <benchmark|run|dark|darkpos> <args...>
  node - "$@" <<'EOF'
const { PublicKey, Keypair } = require("@solana/web3.js");
const { readFileSync } = require("fs");
const { homedir } = require("os");
const SEALED = new PublicKey("FGVuEoWpDGTqBBuR9e26t2t5mDngXgbrAj5CtuLKXLUZ");
const MARKET = new PublicKey("8VSHkhNLN3q3yBUhYmTjgKSCMA55VFzfLPXcgp4Z91vN");
const le = (n, w) => { const b = Buffer.alloc(w); w === 4 ? b.writeUInt32LE(Number(n)) : b.writeBigUInt64LE(BigInt(n)); return b; };
const wallet = () => Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(process.env.ANCHOR_WALLET ?? `${homedir()}/.config/solana/id.json`, "utf8")))).publicKey;
const [kind, a, i, j] = process.argv.slice(2);
const pda = kind === "benchmark"
  ? PublicKey.findProgramAddressSync([Buffer.from("benchmark"), wallet().toBuffer(), le(a, 4)], SEALED)
  : kind === "run"
  ? PublicKey.findProgramAddressSync([Buffer.from("run"), new PublicKey(a).toBuffer(), le(i, 8)], SEALED)
  : kind === "darkpos"
  ? PublicKey.findProgramAddressSync([Buffer.from("darkpos"), new PublicKey(a).toBuffer(), new PublicKey(i).toBuffer(), le(j ?? 0, 8)], MARKET)
  : kind === "dark"
  ? PublicKey.findProgramAddressSync([Buffer.from("dark"), new PublicKey(a).toBuffer(), le(i ?? 0, 8)], MARKET)
  : PublicKey.findProgramAddressSync([Buffer.from("market"), new PublicKey(a).toBuffer(), le(i ?? 0, 8)], MARKET);
console.log(pda[0].toBase58());
EOF
}

# `dark bet` prints the reveal preimage on stdout; the salt is the only piece
# that can't be reconstructed, so fish it out of the KEEP THIS PREIMAGE line.
#   arg $1 = captured bet output; echoes "<pos-salt> <salt-hex>"
parse_preimage() {
  local ps salt
  ps=$(printf '%s\n' "$1" | sed -n 's/.*--pos-salt \([0-9]\{1,\}\).*/\1/p' | head -n1)
  salt=$(printf '%s\n' "$1" | sed -n 's/.*--salt \([0-9a-f]\{64\}\).*/\1/p' | head -n1)
  if [ -z "$ps" ] || [ -z "$salt" ]; then
    echo "could not parse preimage from bet output" >&2
    return 1
  fi
  printf '%s %s\n' "$ps" "$salt"
}

say "1/9 wait for MXE, then comp defs + circuits (once per deployment)"
scripts/wait-mxe.sh
$SEALED chain init

say "2/9 mint a PRIVATE bank (id=$ID) — even the exam under the bet stays ciphertext"
$SEALED chain gen-private --id "$ID" --chunks 1 --out "/tmp/dark-bank-$ID.json"
PBENCH=$(PDA benchmark "$ID")
echo "private benchmark PDA: $PBENCH"

say "3/9 PENDING run + dark market (binary @ $THRESHOLD/32, reveal window ${REVEAL_SECS}s)"
$SEALED run --bank "/tmp/dark-bank-$ID.json" --model mock/oracle-0.65 --out "/tmp/dark-run-$ID.json"
$SEALED chain score --bank "/tmp/dark-bank-$ID.json" --run "/tmp/dark-run-$ID.json" --create-only
RUN=$(PDA run "$PBENCH" 0)
echo "run PDA (pending, outputs committed, unscored): $RUN"
# Dark markets open only while the run is pending and fully unscored —
# on-chain: run.scored_mask == 0 && pending_since == 0.
$SEALED chain market dark open --run "$RUN" --threshold "$THRESHOLD" --resolve-by +86400 --reveal-secs "$REVEAL_SECS" --fee-bps "$FEE_BPS"
MKT=$(PDA dark "$RUN" 0)
echo "dark market PDA: $MKT — outcomes sealed from this tx forward"

say "4/9 two fresh bettors stake OPPOSITE sides — the wire shows commitments, not sides"
solana-keygen new --outfile "$TMP/alice.json" --no-bip39-passphrase -s -f >/dev/null
solana-keygen new --outfile "$TMP/bob.json" --no-bip39-passphrase -s -f >/dev/null
ALICE=$(solana address -k "$TMP/alice.json")
BOB=$(solana address -k "$TMP/bob.json")
echo "alice: $ALICE   bob: $BOB"
# Fund from the default wallet (airdrop fallback if transfer is unavailable).
for PUB in "$ALICE" "$BOB"; do
  solana transfer "$PUB" 0.5 --url "$ANCHOR_PROVIDER_URL" --keypair "$WALLET_KP" --allow-unfunded-recipient >/dev/null 2>&1 \
    || solana airdrop 1 "$PUB" --url "$ANCHOR_PROVIDER_URL" >/dev/null
done

# alice backs [>= 20], bob backs [< 20]. Each bet stores only the commitment;
# the printed preimage (pos-salt + outcome + salt) is the sole reveal key.
A_OUT=$($SEALED chain market dark bet --market "$MKT" --outcome 1 --lamports 250000000 --pos-salt 0 --bettor "$TMP/alice.json" 2>&1)
echo "$A_OUT"
read -r A_PS A_SALT <<<"$(parse_preimage "$A_OUT")" || true
[ -n "${A_PS:-}" ] && [ -n "${A_SALT:-}" ] || { echo "missing alice preimage — cannot reveal later" >&2; exit 1; }
B_OUT=$($SEALED chain market dark bet --market "$MKT" --outcome 0 --lamports 100000000 --pos-salt 0 --bettor "$TMP/bob.json" 2>&1)
echo "$B_OUT"
read -r B_PS B_SALT <<<"$(parse_preimage "$B_OUT")" || true
[ -n "${B_PS:-}" ] && [ -n "${B_SALT:-}" ] || { echo "missing bob preimage — cannot reveal later" >&2; exit 1; }
A_POS=$(PDA darkpos "$MKT" "$ALICE" "$A_PS")
B_POS=$(PDA darkpos "$MKT" "$BOB" "$B_PS")
echo "positions: alice=$A_POS bob=$B_POS (salt stays off-chain)"

say "5/9 the sealed card — pool and amounts are public, sides are not"
$SEALED chain market dark show --market "$MKT"

say "6/9 score the run through MPC — the pool still can't see who won"
$SEALED chain score --bank "/tmp/dark-bank-$ID.json" --run "/tmp/dark-run-$ID.json" --run-index 0

say "7/9 resolve — outcome is fixed on-chain NOW; the ${REVEAL_SECS}s reveal window opens"
RES=$($SEALED chain market dark resolve --market "$MKT" 2>&1)
echo "$RES"
# "dark market resolved (sig): score=<n> outcome <i> [label] — reveal window…"
WIN=$(printf '%s\n' "$RES" | sed -n 's/.*outcome \([0-9]\{1,\}\) \[.*/\1/p' | head -n1)
if [ -z "$WIN" ]; then echo "resolve printed no outcome (cancelled?)" >&2; exit 1; fi
echo "resolved outcome: $WIN"

# Whoever bet the resolved bucket is the winner; only their reveal feeds
# win_total. The mock oracle's score isn't knowable pre-resolution, so pick
# sides after resolve rather than hard-coding alice as the winner.
if [ "$WIN" = "1" ]; then
  W_NAME=alice; W_KP="$TMP/alice.json"; W_PS=$A_PS; W_SALT=$A_SALT; W_OUT=1; W_PUB=$ALICE
  L_NAME=bob;   L_KP="$TMP/bob.json";   L_PS=$B_PS; L_SALT=$B_SALT; L_OUT=0; L_PUB=$BOB
else
  W_NAME=bob;   W_KP="$TMP/bob.json";   W_PS=$B_PS; W_SALT=$B_SALT; W_OUT=0; W_PUB=$BOB
  L_NAME=alice; L_KP="$TMP/alice.json"; L_PS=$A_PS; L_SALT=$A_SALT; L_OUT=1; L_PUB=$ALICE
fi

say "8/9 inside the window: BOTH sides post their preimage — winner counts, loser just proves"
# A loser's reveal is harmless: the score is already final, so a leaked side
# can't be traded on. reveal_dark re-checks the commitment and rejects
# outcome >= n_outcomes (255 is the 'sealed' sentinel).
$SEALED chain market dark reveal --market "$MKT" --outcome "$W_OUT" --salt "$W_SALT" --pos-salt "$W_PS" --bettor "$W_KP"
$SEALED chain market dark reveal --market "$MKT" --outcome "$L_OUT" --salt "$L_SALT" --pos-salt "$L_PS" --bettor "$L_KP"
$SEALED chain market dark show --market "$MKT"

say "9/9 wait out the reveal window, then finalize + claims"
echo "sleeping $((REVEAL_SECS + 45))s — reveal_until = resolved_at + ${REVEAL_SECS}s…"
sleep $((REVEAL_SECS + 45))

# finalize_dark needs clock > reveal_until; retry absorbs validator clock drift.
FINALIZED=""
for _ in 1 2 3 4 5; do
  if $SEALED chain market dark finalize --market "$MKT"; then FINALIZED=1; break; fi
  echo "  window not quite over on-chain — retrying in 20s"
  sleep 20
done
[ -n "$FINALIZED" ] || { echo "finalize_dark never landed" >&2; exit 1; }

# The winner collects pro-rata of the net pot. claim_dark CLOSES the position
# account — the revealed winner's card disappears once paid, which is why the
# loser is left unclaimed: its revealed position stays listed on the final card.
$SEALED chain market dark claim --market "$MKT" --pos-salt "$W_PS" --bettor "$W_KP"
echo "winner $W_NAME balance: $(solana balance "$W_PUB" --url "$ANCHOR_PROVIDER_URL" 2>/dev/null || echo '?')"
# (The loser could still `dark claim` — it pays 0 but returns the position
# rent, no preimage needed. Left open here so the final card shows it.)
$SEALED chain market dark claim-fee --market "$MKT" || true   # authority sweep (fee_bps=$FEE_BPS)

echo
say "final card — the winner was paid and swept; the revealed loser lingers"
$SEALED chain market dark show --market "$MKT"

echo
echo "proof summary:"
echo "  bank     $PBENCH — private: the exam stayed ciphertext too"
echo "  run      $RUN    — scored by MPC while both sides were sealed"
echo "  market   $MKT — opened + filled on a PENDING run"
echo "  alice    $ALICE pos=$A_POS outcome=1 salt=$A_SALT"
echo "  bob      $BOB pos=$B_POS outcome=0 salt=$B_SALT"
echo "  winner   $W_NAME ($W_PUB) — revealed, claimed, position closed"
echo "  throwaway keypairs + preimages: $TMP (never touched the wire — only commitments did)"
echo "verify in the explorer: python3 -m http.server -d . 8788 -> http://localhost:8788/web/?rpc=$ANCHOR_PROVIDER_URL"
