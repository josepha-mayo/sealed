#!/usr/bin/env bash
# Evidence-bundle integrity manifest.
#   scripts/evidence-manifest.sh update  — regenerate docs/evidence/SHA256SUMS
#   scripts/evidence-manifest.sh check   — verify every file matches (CI gate)
# Any change under docs/evidence/ must be followed by `update` — `check`
# fails otherwise, which keeps the committed manifest honest.
set -euo pipefail
cd "$(dirname "$0")/../docs/evidence"
case "${1:-check}" in
  update)
    find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS
    # the explorer serves only web/ — ship a pinned copy there so the in-page
    # bundle fingerprint can bind evidence bytes too (same recipe as
    # `chain fingerprint`: root = sha256(evidenceRoot || webRoot)).
    cp SHA256SUMS ../../web/SHA256SUMS
    echo "SHA256SUMS regenerated: $(wc -l < SHA256SUMS) files (copied to web/SHA256SUMS — run scripts/web-manifest.sh update next)"
    ;;
  check)
    sha256sum -c SHA256SUMS
    cmp -s SHA256SUMS ../../web/SHA256SUMS || { echo "web/SHA256SUMS is stale — run scripts/evidence-manifest.sh update" >&2; exit 1; }
    ;;
  *) echo "usage: $0 [update|check]" >&2; exit 2 ;;
esac
