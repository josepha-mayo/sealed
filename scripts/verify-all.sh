#!/usr/bin/env bash
# One-command audit of the committed evidence bundle — the full judge path:
# offline cryptographic audit, headless in-browser audit regression, and the
# in-browser ShareGrant decryption path. No localnet required.
set -euo pipefail
cd "$(dirname "$0")/.."

say() { printf '\n=== %s ===\n' "$*"; }

say "1/8 offline cryptographic audit (PDA re-derivation, commitment folds, resolution purity)"
node scripts/verify.mjs

say "2/8 in-browser audit regression (same suite, headless)"
node scripts/audit-browser-test.mjs

say "3/8 delegate grant decryption via the vendored RescueCipher"
node scripts/decrypt-grants-test.mjs

say "4/8 calibration rescore — MPC arithmetic recomputed from plaintext answers"
node scripts/rescore.mjs --bank docs/evidence/calibration/bank.json \
  --run docs/evidence/calibration/run-artifact.json \
  --benchmark CSnhf6QySv3BszDkJ47KGooUx86PBpLxxi2iDz42S8fp \
  --run-pubkey GnrRt5GUu6pUQXi7gyXLn7mXMbhXDdneiXbaV6LFFHvi \
  --snapshot web/snapshot.json

say "5/8 committed claim cards + policy certificate — every PDA re-derived, every verdict replayed"
yarn --cwd packages/harness -s cli chain prove --verify \
  ../../docs/evidence/claims
yarn --cwd packages/harness -s cli chain gate --certify-verify \
  ../../docs/evidence/policies/min60-3runs.json
yarn --cwd packages/harness -s cli chain gate --certify-verify \
  ../../docs/evidence/policies/strict70-vouched.json

say "6/8 evidence integrity manifests (sha256sum -c over docs/evidence + web)"
scripts/evidence-manifest.sh check
scripts/web-manifest.sh check

say "7/8 doc-count freshness — every numeric claim must match the bundle"
node scripts/freshness.mjs

say "8/8 submission pre-flight"
node scripts/check-submission.mjs

say "ALL GREEN — every check above recomputed, nothing trusted"
