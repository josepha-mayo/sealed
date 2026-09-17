#!/usr/bin/env bash
# Wait until the sealed MXE account holds a completed keygen result.
# The account exists at genesis but is all-zero until the nodes finish
# keygen; it is 396 bytes when the MXE key is live.
set -uo pipefail
MXE=4Jcw5RrtuoYDM63g1vvKpy8QgPWdg3Jtzfmev71xk4fJ
URL="${ANCHOR_PROVIDER_URL:-http://127.0.0.1:8899}"
for i in $(seq 1 90); do
  n=$(curl -s -m 5 -X POST "$URL" -H 'content-type: application/json' \
      -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getAccountInfo\",\"params\":[\"$MXE\",{\"encoding\":\"base64\"}]}" \
      | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const b=Buffer.from(JSON.parse(s).result?.value?.data?.[0]??"","base64");console.log(b.length)}catch{console.log(0)}})')
  if [ "${n:-0}" -ge 396 ]; then
    echo "MXE key live (${n} bytes) after ~$((i * 10))s"
    exit 0
  fi
  sleep 10
done
echo "MXE key never appeared"
exit 1
