#!/usr/bin/env bash
# Probe with x-opencode-session header. Usage: scripts/zen-probe-session.sh <model>
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
MODEL="${1:-muse-spark-1.3-contributor-free}"
curl -sS -m 120 -w '\nHTTP %{http_code}\n' \
  -H "Authorization: Bearer $SEALED_API_KEY" \
  -H 'content-type: application/json' \
  -H 'x-opencode-session: sealed-bench-7' \
  "$SEALED_API_BASE/chat/completions" \
  -d "{\"model\":\"$MODEL\",\"max_tokens\":256,\"messages\":[{\"role\":\"user\",\"content\":\"What is 17*6? Reply with just ANSWER: number\"}]}" | head -c 1500
echo
