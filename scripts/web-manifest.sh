#!/usr/bin/env bash
# Web-bundle integrity manifest.
#   scripts/web-manifest.sh update  — regenerate web/MANIFEST
#   scripts/web-manifest.sh check   — verify every served file matches (CI gate)
# The explorer fetches MANIFEST and re-hashes every asset it just loaded, so
# the hosted page proves its own bytes equal the repo-committed bytes.
# Regenerate whenever anything under web/ changes.
set -euo pipefail
cd "$(dirname "$0")/../web"
case "${1:-check}" in
  update)
    find . -type f ! -name MANIFEST ! -name standalone.html -print0 | sort -z | xargs -0 sha256sum > MANIFEST
    echo "web/MANIFEST regenerated: $(wc -l < MANIFEST) files"
    ;;
  check)
    sha256sum -c MANIFEST
    ;;
  *) echo "usage: $0 [update|check]" >&2; exit 2 ;;
esac
