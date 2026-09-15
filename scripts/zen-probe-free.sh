#!/usr/bin/env bash
# Probe every *-free model once. Usage: scripts/zen-probe-free.sh
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
for m in mimo-v2.5-free nemotron-3.5-lightning-free ling-3.0-flash-fin-free nemotron-3-ultra-free muse-spark-1.2-contributor-free muse-spark-1.3-contributor-free; do
  echo "--- $m"
  curl -sS -m 60 -w '\nHTTP %{http_code}\n' -H "Authorization: Bearer $SEALED_API_KEY" -H 'content-type: application/json' \
    -H 'x-opencode-session: sealed-bench-7' \
    "$SEALED_API_BASE/chat/completions" \
    -d "{\"model\":\"$m\",\"max_tokens\":64,\"messages\":[{\"role\":\"user\",\"content\":\"What is 17*6? End with a line ANSWER: <n>\"}]}" | head -c 900
  echo
done
