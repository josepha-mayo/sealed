#!/usr/bin/env bash
# List models available on the configured OpenAI-compatible endpoint (reads .env).
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
curl -sS -H "Authorization: Bearer $SEALED_API_KEY" "${SEALED_API_BASE}/models" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const rows=(j.data||j);console.log(rows.length+" models");for(const x of rows)console.log(JSON.stringify(x).slice(0,220))})'
