#!/usr/bin/env bash
# Build circuits + program, then run the localnet end-to-end test. Logs to ~/sealed-e2e.log.
# Usage: scripts/e2e.sh [--skip-build] [extra args for `arcium test`]
set -uo pipefail
cd "$(dirname "$0")/.."
LOG="$HOME/sealed-e2e.log"
: > "$LOG"
if [ "${1:-}" = "--skip-build" ]; then
  shift
else
  arcium build 2>&1 | grep -v -E 'Stack offset|overwrites values in the frame|^\s*$' | tee -a "$LOG" | tail -5
  if [ "${PIPESTATUS[0]}" -ne 0 ]; then echo "BUILD FAILED"; exit 1; fi
fi
arcium test "$@" 2>&1 | tee -a "$LOG" | grep -E -A3 'Sealed|passing|failing|Error|error|✓|✔|[0-9]+\)' | grep -v -E 'Stack offset|overwrites values in the frame' | head -80
rc=${PIPESTATUS[0]}
echo "EXIT=$rc"
exit "$rc"
