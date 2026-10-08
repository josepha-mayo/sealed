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

say "5/8 whole-tree artifact replay — one recursive pass, 138 artifacts, non-artifacts skipped"
yarn --cwd packages/harness -s cli chain artifact \
  ../../docs/evidence --recursive --snapshot ../../web/snapshot.json

say "6/8 evidence integrity manifests (sha256sum -c over docs/evidence + web)"
scripts/evidence-manifest.sh check
scripts/web-manifest.sh check

say "6b. second-language verdict — Python (stdlib-only) recomputes the root + re-derives PDAs"
python3 scripts/verify.py && python3 scripts/verify.py --tamper && python3 scripts/verify.py --decrypt \
  && python3 scripts/verify.py --rescore \
  && python3 scripts/verify.py --card docs/evidence/board.json >/dev/null \
  && echo "  --card pin: board.json replays solo in Python"

say "6bb. CLI forgery lab — every artifact kind's canned attack dies (TypeScript)"
for CARD in \
  board.json \
  matches/qwen2.5-3b-instruct-vs-qwen2.5-1.5b-instruct.json \
  claims/qwen2.5-3b-instruct.json \
  trails/qwen3b-ladder-deadheat.json \
  digest.json \
  banks/sealed-gen.json \
  artifacts.json \
  bounties/claimed-20of32.json \
  grants/sealed-priv-panel.json \
  policies/min60-3runs.json \
  positions/winning-band.json \
; do
  yarn --cwd packages/harness -s cli chain artifact \
    "../../docs/evidence/${CARD}" --tamper --snapshot ../../web/snapshot.json
done

say "6bc. committed IDLs — idl/ mirrors target/idl when a build exists"
IDL_DRIFT=0
for S in sealed market; do
  if [ -f "target/idl/$S.json" ]; then
    cmp -s "target/idl/$S.json" "idl/$S.json" || { echo "  idl/$S.json is stale vs target/idl — refresh: cp target/idl/$S.json idl/"; IDL_DRIFT=1; }
  fi
done
[ "$IDL_DRIFT" = 0 ] && echo "  committed IDLs in sync (cold-clone replay floor)"

say "6bd. cold-clone simulation — replay with target/idl hidden"
if [ -d target/idl ]; then
  mv target/idl target/idl.stashed
  if yarn --cwd packages/harness -s cli chain artifact \
      ../../docs/evidence/trails/qwen3b-private-duel.json \
      --snapshot ../../web/snapshot.json >/dev/null 2>&1; then
    echo "  committed idl/ floor replays without a build"
  else
    mv target/idl.stashed target/idl
    echo "  COLD-CLONE FAIL — artifact replay needs target/idl (gitignored)"
    exit 1
  fi
  mv target/idl.stashed target/idl
else
  yarn --cwd packages/harness -s cli chain artifact \
    ../../docs/evidence/trails/qwen3b-private-duel.json \
    --snapshot ../../web/snapshot.json >/dev/null
  echo "  no build present — replay ran on the committed idl/ floor"
fi

say "6c. the capsule — standalone.html is a byte-fresh mirror of the pinned bundle"
node scripts/gen-standalone.mjs --check

say "7/8 doc-count freshness — every numeric claim must match the bundle"
node scripts/freshness.mjs

say "8/8 submission pre-flight"
node scripts/check-submission.mjs

say "bundle fingerprint — every pinned byte re-hashed, one root for all of it"
yarn --cwd packages/harness -s cli chain fingerprint

# on-chain notarization drift — informational, not gating: the anchored
# root must match the CURRENT tree for the timestamp to describe THIS
# evidence. Offline-safe (no RPC); --check-anchor adds the live fetch.
if [ -f docs/evidence-anchor.json ]; then
  ANCHOR_ROOT=$(node -e "console.log(JSON.parse(require('fs').readFileSync('docs/evidence-anchor.json','utf8')).bundleRoot)")
  CUR_ROOT=$(yarn --cwd packages/harness -s cli chain fingerprint --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).bundleRoot))")
  if [ "$ANCHOR_ROOT" = "$CUR_ROOT" ]; then
    echo "  anchor drift check  IN SYNC — devnet memo tx carries this exact root (docs/evidence-anchor.json)"
  else
    echo "  anchor drift check  DRIFT — evidence moved since the anchor was posted; re-run: chain fingerprint --anchor docs/evidence-anchor.json"
  fi
fi

say "ALL GREEN — every check above recomputed, nothing trusted"
