#!/usr/bin/env bash
# verify-deployed.sh — prove the on-chain program bytes equal this repo's
# build. Dumps each program's ELF from the cluster and sha256-compares it
# against target/deploy/*.so. "Deployed" is only real when the bytes match.
#
#   scripts/verify-deployed.sh            # check both programs on devnet
#   scripts/verify-deployed.sh localnet   # any solana -u target works
#
# Exit 0 only when every dumped program is byte-identical to the local build.
set -uo pipefail
cd "$(dirname "$0")/.."

CLUSTER="${1:-devnet}"
SEALED_PID="FGVuEoWpDGTqBBuR9e26t2t5mDngXgbrAj5CtuLKXLUZ"
MARKET_PID="8VSHkhNLN3q3yBUhYmTjgKSCMA55VFzfLPXcgp4Z91vN"

fail=0
for pair in "sealed:$SEALED_PID" "market:$MARKET_PID"; do
  name="${pair%%:*}"; pid="${pair##*:}"
  so="target/deploy/$name.so"
  dump="$(mktemp /tmp/deployed-$name.XXXXXX.so)"
  if [[ ! -f "$so" ]]; then
    echo "SKIP  $name — no local build at $so (run anchor build first)"
    continue
  fi
  if ! solana program dump "$pid" -u "$CLUSTER" "$dump" >/dev/null 2>&1; then
    echo "FAIL  $name — could not dump $pid from $CLUSTER"
    fail=1; continue
  fi
  onchain="$(sha256sum "$dump" | cut -d' ' -f1)"
  local_sha="$(sha256sum "$so" | cut -d' ' -f1)"
  if [[ "$onchain" == "$local_sha" ]]; then
    echo "MATCH $name  ${pid:0:8}…  sha256 ${onchain:0:16}… == local build"
  else
    echo "STALE $name  ${pid:0:8}…  on-chain ${onchain:0:16}… != local ${local_sha:0:16}…"
    fail=1
  fi
  rm -f "$dump"
done
exit "$fail"
