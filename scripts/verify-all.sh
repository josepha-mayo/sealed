#!/usr/bin/env bash
# One-command audit of the committed evidence bundle — the full judge path:
# offline cryptographic audit, headless in-browser audit regression, and the
# in-browser ShareGrant decryption path. No localnet required.
set -euo pipefail
cd "$(dirname "$0")/.."

say() { printf '\n=== %s ===\n' "$*"; }

say "1/4 offline cryptographic audit (PDA re-derivation, commitment folds, resolution purity)"
node scripts/verify.mjs

say "2/4 in-browser audit regression (same suite, headless)"
node scripts/audit-browser-test.mjs

say "3/5 delegate grant decryption via the vendored RescueCipher"
node scripts/decrypt-grants-test.mjs

say "4/5 calibration rescore — MPC arithmetic recomputed from plaintext answers"
node scripts/rescore.mjs --bank docs/evidence/calibration/bank.json \
  --run docs/evidence/calibration/run-artifact.json \
  --benchmark CSnhf6QySv3BszDkJ47KGooUx86PBpLxxi2iDz42S8fp \
  --run-pubkey GnrRt5GUu6pUQXi7gyXLn7mXMbhXDdneiXbaV6LFFHvi \
  --snapshot web/snapshot.json

say "5/5 submission pre-flight"
node scripts/check-submission.mjs

say "ALL GREEN — every check above recomputed, nothing trusted"
