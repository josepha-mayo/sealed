#!/usr/bin/env bash
# Show metadata for models matching a regex. Usage: scripts/zen-model-info.sh <regex>
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
curl -sS -H "Authorization: Bearer $SEALED_API_KEY" "$SEALED_API_BASE/models" \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d);const re=new RegExp(process.argv[1]);const ms=(j.data||j).filter(m=>re.test(m.id));console.log(JSON.stringify(ms,null,1).slice(0,4000))})' "$1"
