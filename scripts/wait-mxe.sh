#!/usr/bin/env bash
# Wait until the sealed MXE account exists on localnet (keygen done).
MXE=4Jcw5RrtuoYDM63g1vvKpy8QgPWdg3Jtzfmev71xk4fJ
for i in $(seq 1 90); do
  if curl -s -m 5 -X POST http://127.0.0.1:8899 -H 'content-type: application/json' \
      -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getAccountInfo\",\"params\":[\"$MXE\"]}" | grep -q '"owner"'; then
    echo "MXE up after $((i * 10))s"
    exit 0
  fi
  sleep 10
done
echo "MXE never appeared"
exit 1
