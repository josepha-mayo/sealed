#!/usr/bin/env bash
# Minimal chat-completions probe against the configured endpoint. Usage: scripts/zen-probe.sh <model> [json-extra]
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
MODEL="$1"; EXTRA="${2:-}"
BODY="{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"What is 17*6? End with a line ANSWER: <n>\"}]${EXTRA:+,$EXTRA}}"
curl -sS -w '\nHTTP %{http_code}\n' -H "Authorization: Bearer $SEALED_API_KEY" -H 'content-type: application/json' \
  "${SEALED_API_BASE}/chat/completions" -d "$BODY" | head -c 1500
echo
