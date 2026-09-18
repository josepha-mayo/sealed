#!/usr/bin/env bash
# Wait until the sealed MXE account holds a finalized keygen result.
# The account exists at genesis with utility_pubkeys = Unset (tag byte 1 at
# offset 94, len ~295); once the dealer's keygen is finalized on-chain the
# field flips to Set (tag byte 0, len >= 289). `arcium finalize-mxe-keys`
# completes that step if it stalls (see AGENTS.md).
set -uo pipefail
MXE=4Jcw5RrtuoYDM63g1vvKpy8QgPWdg3Jtzfmev71xk4fJ
URL="${ANCHOR_PROVIDER_URL:-http://127.0.0.1:8899}"
for i in $(seq 1 90); do
  n=$(curl -s -m 5 -X POST "$URL" -H 'content-type: application/json' \
      -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getAccountInfo\",\"params\":[\"$MXE\",{\"encoding\":\"base64\"}]}" \
      | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const b=Buffer.from(JSON.parse(s).result?.value?.data?.[0]??"","base64");console.log(b.length>=289&&b[94]===0?"LIVE":b.length)}catch{console.log(0)}})')
  if [ "${n:-0}" = "LIVE" ]; then
    echo "MXE key live after ~$((i * 10))s"
    exit 0
  fi
  sleep 10
done
echo "MXE key never appeared (last len ${n:-?})"
exit 1
