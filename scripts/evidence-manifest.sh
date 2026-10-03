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
    echo "SHA256SUMS regenerated: $(wc -l < SHA256SUMS) files"
    ;;
  check)
    sha256sum -c SHA256SUMS
    ;;
  *) echo "usage: $0 [update|check]" >&2; exit 2 ;;
esac
