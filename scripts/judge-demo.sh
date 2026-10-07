#!/usr/bin/env bash
# scripts/judge-demo.sh — the 90-second keyless audit, narrated.
# Every line is real: no wallet, no node, no trust in the hosted page.
# Record: asciinema rec --idle-time-limit 1 docs/audit.cast -c "bash scripts/judge-demo.sh"
#         agg --speed 1.5 docs/audit.cast docs/audit.gif
set -e
cd "$(dirname "$0")/.."
B=$'\033[1m'; D=$'\033[2m'; X=$'\033[0m'
say() { printf "\n${B}== %s ==${X}\n" "$*"; }
run() { printf "${D}\$ %s${X}\n" "$*"; "$@"; }

say "sealed — a benchmark nobody operates, scored by an MPC cluster, settled by the chain"
printf "%s\n" "Evidence: 138 portable artifacts, one sha256 root, anchored on Solana devnet."
printf "%s\n" "This terminal proves it — keyless end to end."

say "1 · a SECOND implementation — stdlib Python re-hashes the bundle, unpacks raw account bytes, re-derives PDAs"
run python3 scripts/verify.py

say "2 · every artifact replays — 138 cards through their own verifiers"
run yarn --cwd packages/harness cli chain artifact ../../docs/evidence --recursive --snapshot ../../web/snapshot.json

say "3 · watch a forgery die — the lab mutates the card's own fields"
run yarn --cwd packages/harness cli chain artifact ../../docs/evidence/board.json --tamper --snapshot ../../web/snapshot.json

say "4 · eleven committed forgeries — each verifies BY being rejected"
run yarn --cwd packages/harness cli chain artifact ../../docs/evidence/tamper --snapshot ../../web/snapshot.json

say "5 · the whole evidence base is ONE hash — timestamped on Solana devnet"
run yarn --cwd packages/harness cli chain fingerprint

say "zero-setup path: https://josepha-mayo.github.io/sealed/?mega=1 — the same proofs in your browser"
