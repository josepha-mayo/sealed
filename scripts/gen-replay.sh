#!/usr/bin/env bash
# Regenerate docs/evidence/replay.txt — the captured offline-replay
# transcript. Every command runs against the committed snapshot with no
# RPC/wallet; the printed `$ sealed …` lines are what a judge copies.
# Run from the repo root:  scripts/gen-replay.sh  (then
# scripts/evidence-manifest.sh update && scripts/web-manifest.sh update)
set -euo pipefail
cd "$(dirname "$0")/.."
SNAP="--snapshot ../../web/snapshot.json"
CLI="yarn --cwd packages/harness -s cli chain"
OUT=docs/evidence/replay.txt

emit() { # $1 = shown command suffix, $2 = actual pipeline (optional), $3 = allow-fail
  local shown="$1" actual="${2:-$1}"
  # strip display-only "(note)" suffixes from the command that runs
  [ $# -eq 1 ] && actual="$(printf '%s' "$shown" | sed 's/   *([^)]*)$//')"
  {
    printf '\n$ sealed chain %s\n' "$shown"
    if [ "${3:-}" = "ok" ]; then eval "$CLI $actual" || true; else eval "$CLI $actual"; fi
  } >> "$OUT"
}

{
  cat <<'HDR'
SEALED — offline replay transcript
===================================

Every command below ran against the committed evidence bundle
(web/snapshot.json — eight merged localnet epochs) with no RPC, no
wallet, and no localnet. Reproduce any line yourself (shown as `sealed`
— the package bin; from the repo root that is
`yarn --cwd packages/harness cli chain … --snapshot ../../web/snapshot.json`,
or `export SEALED_SNAPSHOT=<path>` once and drop the flag everywhere).

The loader sha256-checks snapshot.json against web/MANIFEST first and
warns loudly if the bytes are not the committed ones.

HDR
} > "$OUT"

emit "stats $SNAP"
emit "anomalies $SNAP"
emit "gate --all --min-pct 70 --min-runs 2 $SNAP"
emit "gate --sweep $SNAP   (head -24)" "gate --sweep $SNAP | head -24"
emit "gate qwen2.5-3b-instruct --why $SNAP"
emit "records --wilson $SNAP   (head -12)" "records --wilson $SNAP | head -12"
emit "records --vouched $SNAP"
emit "compare --all $SNAP   (head -16)" "compare --all $SNAP | head -16"
emit "compare --matrix $SNAP   (head -20)" "compare --matrix $SNAP | head -20"
emit "compare ladder/model-a ladder/model-b $SNAP"
emit "matrix $SNAP   (head -18)" "matrix $SNAP | head -18"
emit "model qwen2.5-3b-instruct $SNAP"
emit "modelrec qwen2.5-3b-instruct $SNAP"
emit "market board $SNAP"
emit "market divergence $SNAP"
emit "market calibration $SNAP"
emit "market sharps $SNAP"
emit "market escrow $SNAP"
emit "market live $SNAP   (head -14)" "market live $SNAP | head -14"
emit "market bounties $SNAP   (head -10)" "market bounties $SNAP | head -10"
emit "banks --depth $SNAP   (head -14)" "banks --depth $SNAP | head -14"
emit "bank A6UkXHYNM8msZgw2PNwAXAj4jTLFLM4equFEZoFtCty1 $SNAP"
emit "trail GnrRt5GUu6pUQXi7gyXLn7mXMbhXDdneiXbaV6LFFHvi $SNAP"
emit "feed --limit 14 $SNAP"
emit "feed --model qwen2.5-3b-instruct --limit 8 $SNAP"
emit "search 7Lt4RooJSmDg3ibpDYrwQ2CgengYdPAyfurqREfmAqvm $SNAP"
emit "search sealed-test $SNAP   (bank-name fallback)"
emit "feed --pk Hn21uoPQYi8xEsMGueWBeE9aLSnBywxcnwYueRr8WGW7 $SNAP"
emit "market position 14AQTPw2KjckgvkTWbyVVpKp2mcfZgQuNaRFpdt6gnd6 $SNAP"
emit "market venue 7Lt4RooJSmDg3ibpDYrwQ2CgengYdPAyfurqREfmAqvm $SNAP   (head -20)" "market venue 7Lt4RooJSmDg3ibpDYrwQ2CgengYdPAyfurqREfmAqvm $SNAP | head -20"
emit "runs --post-reveal $SNAP   (head -10)" "runs --post-reveal $SNAP | head -10"
emit "runs --attested $SNAP   (head -8)" "runs --attested $SNAP | head -8"
emit "gate --certify-verify docs/evidence/policies/min60-3runs.json" "gate --certify-verify ../../docs/evidence/policies/min60-3runs.json"
emit "prove --verify docs/evidence/claims/qwen2.5-3b-instruct.json" "prove --verify ../../docs/evidence/claims/qwen2.5-3b-instruct.json"
emit "prove --verify docs/evidence/claims/ladder_model-a.json --min-pct 20" "prove --verify ../../docs/evidence/claims/ladder_model-a.json --min-pct 20"
emit "board --verify docs/evidence/board.json $SNAP   (the leaderboard as a card)" "board --verify ../../docs/evidence/board.json $SNAP"
emit "bank --verify docs/evidence/banks/sealed-priv.json $SNAP   (the exam as a card — ciphertext fold, no key)" "bank --verify ../../docs/evidence/banks/sealed-priv.json $SNAP"
emit "market position --verify docs/evidence/positions/winning-band.json $SNAP   (the bettor's receipt — payout recomputed)" "market position --verify ../../docs/evidence/positions/winning-band.json $SNAP"
emit "market bounty card --verify docs/evidence/bounties/claimed-20of32.json $SNAP   (the sponsor's certificate — qualifies gate replayed)" "market bounty card --verify ../../docs/evidence/bounties/claimed-20of32.json $SNAP"
emit "grant --verify docs/evidence/grants/sealed-priv-panel.json $SNAP   (the viewer's certificate — questions moved, answers never did)" "grant --verify ../../docs/evidence/grants/sealed-priv-panel.json $SNAP"
emit "artifact docs/evidence --recursive $SNAP   (the one command — 138 artifacts)" "artifact ../../docs/evidence --recursive $SNAP"
emit "catalog --check   (the index proves itself complete)" "catalog --dir ../../docs/evidence --check"
emit "artifact docs/evidence/tamper/board.inflate-a-receipt-s-score.json $SNAP   (a committed lie — 'verifying' it proves the forgery dies)" "artifact ../../docs/evidence/tamper/board.inflate-a-receipt-s-score.json $SNAP"
emit "artifact docs/evidence/board.json --tamper $SNAP   (the forgery lab — attack the leaderboard yourself)" "artifact ../../docs/evidence/board.json --tamper $SNAP"
emit "diff web/snapshot.json web/snapshot.json   (integrity self-check)" "diff ../../web/snapshot.json ../../web/snapshot.json"
{
  printf '\n$ sealed chain fingerprint   (the one hash — every pinned byte re-checked)\n'
  printf '%s\n' 'NOTE: this transcript rewrites replay.txt while it runs — the'
  printf '%s\n' 'fingerprint flagging THAT file mid-flight is the feature working.'
  printf '%s\n' 'The committed copy passes (see scripts/verify-all.sh stage output).'
  eval "$CLI fingerprint --evidence ../../docs/evidence --web ../../web" || true
} >> "$OUT"

echo "replay.txt regenerated: $(grep -c '^\$ sealed' "$OUT") commands"
