#!/usr/bin/env bash
# Try several request shapes against Zen to find one that works. Usage: scripts/zen-probe-variants.sh <model>
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
MODEL="${1:-muse-spark-1.3-contributor-free}"
URL="$SEALED_API_BASE/chat/completions"
MSG='"messages":[{"role":"user","content":"What is 17*6? End with a line ANSWER: <n>"}]'

try() { # name body
  echo "=== $1"
  curl -sS -m 60 -w '\nHTTP %{http_code}\n' -H "Authorization: Bearer $SEALED_API_KEY" -H 'content-type: application/json' "$URL" -d "$2" | head -c 1200
  echo
}

try "bare"            "{\"model\":\"$MODEL\",$MSG}"
try "max_tokens"      "{\"model\":\"$MODEL\",\"max_tokens\":64,$MSG}"
try "max_completion"  "{\"model\":\"$MODEL\",\"max_completion_tokens\":64,$MSG}"
try "stream"          "{\"model\":\"$MODEL\",\"stream\":true,\"max_tokens\":64,$MSG}"
try "temp0"           "{\"model\":\"$MODEL\",\"temperature\":0,\"max_tokens\":64,$MSG}"
try "sys+user"        "{\"model\":\"$MODEL\",\"max_tokens\":64,\"messages\":[{\"role\":\"system\",\"content\":\"You are helpful.\"},{\"role\":\"user\",\"content\":\"What is 17*6? End with a line ANSWER: <n>\"}]}"
