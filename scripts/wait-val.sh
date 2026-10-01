#!/bin/bash
# Wait for the test-validator to answer getSlot, then restart arx nodes.
for i in $(seq 1 60); do
  s=$(curl -s -m 2 http://127.0.0.1:8899 -X POST -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"getSlot"}' | python3 -c 'import sys,json;print(json.load(sys.stdin).get("result",0))' 2>/dev/null || echo 0)
  if [ "$s" -gt 0 ]; then
    echo "validator live at slot $s"
    docker restart artifacts-arx-node-0-1 artifacts-arx-node-1-1 artifacts-arcium-trusted-dealer-1 2>/dev/null
    echo "arx nodes restarted"
    exit 0
  fi
  sleep 3
done
echo "TIMEOUT — validator never answered"; tail -5 /tmp/validator.log; exit 1
