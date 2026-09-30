#!/usr/bin/env bash
# Restart the Sealed localnet after `arcium localnet` tears it down (it times
# out waiting for backup nodes and removes everything). The artifacts/ dir
# holds the genesis-baked accounts (MXE, nodes, circuits) from the last
# bootstrap, so this re-launches the validator + primary arx nodes directly.
#
# Usage:
#   scripts/localnet-up.sh          # resume existing .anchor/test-ledger
#   scripts/localnet-up.sh --wipe   # fresh ledger (required when sealed.so changed)
set -euo pipefail
cd "$(dirname "$0")/.."
ART=artifacts

if [ "${1:-}" = "--wipe" ]; then
  # Kill a live validator FIRST — otherwise it keeps producing on in-memory
  # state and silently resurrects the old ledger over the wipe.
  pkill -f "solana-test-validator.*test-ledger" 2>/dev/null || true
  sleep 3
  rm -rf .anchor/test-ledger
  echo "wiped ledger"
fi

if ! pgrep -f "solana-test-validator.*test-ledger" >/dev/null; then
  args=(
    --ledger .anchor/test-ledger
    --mint 4RUW4pDm38PEoVAfGe61vCbQLEJdbA9t5Je6kswmyhDc
    --upgradeable-program 8VSHkhNLN3q3yBUhYmTjgKSCMA55VFzfLPXcgp4Z91vN "$PWD/target/deploy/market.so" 4RUW4pDm38PEoVAfGe61vCbQLEJdbA9t5Je6kswmyhDc
    --bpf-program FGVuEoWpDGTqBBuR9e26t2t5mDngXgbrAj5CtuLKXLUZ "$PWD/target/deploy/sealed.so"
    --upgradeable-program Arcj82pX7HxYKLR92qvgZUAd7vGS1k4hQvAFcPATFdEQ "$PWD/$ART/arcium_program_0.14.1.so" 4RUW4pDm38PEoVAfGe61vCbQLEJdbA9t5Je6kswmyhDc
    --upgradeable-program ArcStnN9zZZVB5WjgPhLHjYpY7Gb29mzb96ySsb1kxgq "$PWD/$ART/arcium_staking_program_0.14.1.so" 4RUW4pDm38PEoVAfGe61vCbQLEJdbA9t5Je6kswmyhDc
    --upgradeable-program L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95 "$ART/lighthouse.so" 4RUW4pDm38PEoVAfGe61vCbQLEJdbA9t5Je6kswmyhDc
    --bind-address 127.0.0.1 --rpc-port 8899
  )
  # every artifacts/*.json is a genesis account
  while IFS= read -r f; do
    pk=$(basename "$f" .json | sed 's/.*_acc_//; s/^wallet_acc_//')
    args+=(--account "$(python3 -c "import json;print(json.load(open('$f'))['pubkey'])" 2>/dev/null || echo "$pk")" "$f")
  done < <(find "$ART" -maxdepth 1 -name "*.json")
  setsid solana-test-validator "${args[@]}" > /tmp/validator.log 2>&1 < /dev/null &
  echo "validator launching (pid $!)"
else
  echo "validator already running"
fi

for i in $(seq 1 30); do
  slot=$(curl -s -m 2 http://127.0.0.1:8899 -X POST -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"getSlot"}' | python3 -c 'import sys,json;print(json.load(sys.stdin).get("result",0))' 2>/dev/null || echo 0)
  [ "$slot" -gt 0 ] && break
  sleep 1
done
echo "validator slot: $slot"

docker compose -f "$ART/docker-compose-arx-env.yml" up -d 2>&1 | tail -3
echo "nodes coming up; restart them once the chain is ahead of their stored context slot:"
echo "  docker restart artifacts-arx-node-0-1 artifacts-arx-node-1-1 artifacts-arcium-trusted-dealer-1"
