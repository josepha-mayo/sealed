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

say "3/4 delegate grant decryption via the vendored RescueCipher"
node scripts/decrypt-grants-test.mjs

say "4/4 submission pre-flight"
node scripts/check-submission.mjs

say "ALL GREEN — every check above recomputed, nothing trusted"
